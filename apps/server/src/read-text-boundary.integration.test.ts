import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReasoningInput, ProviderResolver } from "@companion/providers";
import { readAuthorizedLocalText, type HostReadTextEffects } from "./read-text-effect.js";
import { executeProductionCognition } from "./cognition-production.js";
import { SERVER_MCP_READ_TEXT_CAPABILITY_REF } from "./mcp-capability-binding.js";

async function throughProduction(path: string, signal?: AbortSignal) {
  const inputs: ReasoningInput[] = [];
  const providers = {
    getReasoningProvider: () => ({
      name: "boundary-input-recorder",
      async generateReasoning(input: ReasoningInput) {
        inputs.push(input);
        return {
          answer:
            inputs.length === 1
              ? "REQUEST_CAPABILITY\n" +
                JSON.stringify({
                  capabilityRef: SERVER_MCP_READ_TEXT_CAPABILITY_REF,
                  request: "Read admitted evidence"
                })
              : "COMPLETE\nDone",
          reasoning: "",
          finishReason: "stop",
          model: "boundary-input-recorder"
        };
      }
    })
  } as unknown as Pick<ProviderResolver, "getReasoningProvider">;
  const result = await executeProductionCognition({
    providers,
    request: { version: "character-harness-5g.v1", kind: "NEED_COGNITION", focus: "verify" },
    problem: "Inspect the authorized artifact; distinguish incomplete evidence.",
    runtimeAuthorizedPath: path,
    readTextEffects: {
      execute: (input) =>
        readAuthorizedLocalText(input.path, input.signal ?? new AbortController().signal)
    } as HostReadTextEffects,
    effectContext: {
      scope: "authorized-scope",
      cause: { kind: "JOURNAL_EVENT", namespace: "probe-journal", eventId: "jev1_aaaaaaaaaaaaaaaa" }
    },
    execution: { executionId: "boundary-read", isCurrent: () => true },
    limits: { maxReasoningRounds: 3, maxCapabilityCalls: 1, timeBudgetMs: 60000 },
    ...(signal ? { signal } : {})
  });
  return { inputs, result };
}
describe("authorized read -> observation -> production Reasoning boundary", () => {
  it.each([16000, 16001, 64000])(
    "retains bounded evidence and declares omitted suffix for %i ASCII units",
    async (length) => {
      const dir = await mkdtemp(join(tmpdir(), "yuvi-contract-"));
      try {
        const path = join(dir, "evidence.txt");
        const text = "BEGIN_VALID_EVIDENCE\n" + "x".repeat(length - 21);
        await writeFile(path, text);
        const { inputs } = await throughProduction(path);
        expect(inputs).toHaveLength(2);
        const next = JSON.stringify(inputs[1]);
        expect(next).toContain("BEGIN_VALID_EVIDENCE");
        expect(next).toContain(SERVER_MCP_READ_TEXT_CAPABILITY_REF);
        if (length > 16000) {
          expect(next).toContain("PARTIAL");
          expect(next).toContain(String(length));
        } else expect(next).not.toContain("PARTIAL");
        expect(next).not.toContain("Status: ERROR");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
  it("preserves Unicode and reports bytes versus character units honestly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuvi-unicode-"));
    try {
      const path = join(dir, "evidence.txt");
      const text = "a".repeat(15999) + "😀" + "语".repeat(1000);
      await writeFile(path, text);
      const { inputs } = await throughProduction(path);
      const next = inputs[1]!.messages.map((m) => m.content).join("\n");
      expect(next).toContain("PARTIAL");
      expect(next).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
      expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(text.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("represents empty and whitespace-only authorized artifacts as valid observations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuvi-empty-"));
    try {
      for (const text of ["", "   \n"]) {
        const path = join(dir, "evidence.txt");
        await writeFile(path, text);
        const { inputs } = await throughProduction(path);
        const next = JSON.stringify(inputs[1]);
        expect(next).toContain("Status: SUCCESS");
        expect(next).not.toContain("Status: ERROR");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("retains real invalid-encoding/missing/oversize failures and cancellation without fabricated content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuvi-failure-"));
    try {
      for (const [name, bytes] of [
        ["invalid", Buffer.from([0xc3, 0x28])],
        ["oversized", Buffer.alloc(64001, 65)]
      ] as const) {
        const path = join(dir, name);
        await writeFile(path, bytes);
        await expect(
          readAuthorizedLocalText(path, new AbortController().signal)
        ).rejects.toBeDefined();
        const { inputs } = await throughProduction(path);
        expect(JSON.stringify(inputs[1])).toContain("Status: ERROR");
      }
      const missing = join(dir, "missing");
      await expect(
        readAuthorizedLocalText(missing, new AbortController().signal)
      ).rejects.toBeDefined();
      expect(JSON.stringify((await throughProduction(missing)).inputs[1])).toContain(
        "Status: ERROR"
      );
      const cancelled = new AbortController();
      cancelled.abort();
      expect((await throughProduction(missing, cancelled.signal)).inputs).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
