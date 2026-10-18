/** Real Chat through the production Character Port, with a frozen actual Qwen
 * report. Isolates expression fidelity; not another actual Vision/Host/A9 test. */
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  PromptBuilder,
  assembleCanonicalContext
} from "../../../../packages/prompt-builder/src/index.js";
import { createProviderRegistryFromEnv } from "../../../../packages/providers/src/index.js";
const output = process.env.YUVI_GROUNDING_OUTPUT!,
  root = process.env.YUVI_GROUNDING_CHECKOUT!;
if (!output || !root) throw Error("Explicit experiment paths required");
const { createServerCharacterPort } = await import(
  pathToFileURL(root + "/apps/server/src/character-runtime.ts").href
);
const actual = JSON.parse(
  await readFile(
    new URL("../../durable-observation-retrieval/evidence/vision-results.json", import.meta.url),
    "utf8"
  )
).providerReports[0];
const visualEvidence = { status: "AVAILABLE" as const, observations: actual.actualProviderReport };
const questions = [
  "Describe the card, including chart values and relative heights.",
  "Which bar is shortest, and what is its value?",
  "How much larger is C than A, and which is larger?",
  "请按从高到低列出三个柱子的标签和值。",
  "What is the color of the back of the card?"
];
const provider = createProviderRegistryFromEnv(process.env).getChatProvider(),
  report: any = {
    schema: "character.grounding-eval.v1",
    kind: "actual-chat-production-character-frozen-real-vision-report",
    implementationRoot: root,
    sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    reportSource: actual.file,
    observation: actual.actualProviderReport,
    cases: []
  };
for (let repeat = 0; repeat < 2; repeat++)
  for (const question of questions) {
    const calls: any[] = [],
      prompt = new PromptBuilder().buildPrompt({
        systemIdentity: "Synthetic Alice",
        characterStyle: "Warm and precise.",
        userMessage: question
      });
    const canonicalContext = assembleCanonicalContext({
      semanticSections: [
        {
          kind: "IDENTITY",
          state: "KNOWN",
          summary: "Synthetic Alice for isolated evidence experiments."
        }
      ],
      promptSections: prompt.sections,
      currentInput: question,
      multimodalEvidence: JSON.stringify(visualEvidence)
    });
    const start = performance.now();
    let result: any;
    try {
      const gate = await createServerCharacterPort().generate({
        prompt,
        canonicalContext,
        userMessage: question,
        visualEvidence,
        contextWindow: 65536,
        generateChat: async (input: any) => {
          calls.push(input);
          return provider.generateReply({ ...input, temperature: 0, maxTokens: 768 });
        }
      });
      const body = gate.decision.reply.body;
      if (body) {
        calls.push(body);
        const answer = await provider.generateReply({ ...body, temperature: 0, maxTokens: 768 });
        result = {
          answer: answer.message.content,
          finishReason: answer.finishReason,
          usage: answer.tokenUsage
        };
      } else result = { disposition: gate.decision.reply.disposition };
    } catch (e) {
      result = { error: String(e) };
    }
    report.cases.push({ repeat, question, ...result, elapsedMs: performance.now() - start, calls });
    await writeFile(output, JSON.stringify(report, null, 2));
  }
