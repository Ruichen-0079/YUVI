import { randomUUID } from "node:crypto";
import { canonicalLineageJson, lineageDigest } from "../lineage-encoding.js";
import type { AuthorityQuery } from "./types.js";
import { z } from "zod";
import type { MemoryExtractionReasoner, LlmMemoryExtractorOptions } from "../extractor.js";
import type { MemoryIngestionInput, MemoryIngestionResult } from "../ingestion.js";
import type { MemoryExtractorStatus } from "../types.js";
import type { MemoryEvent, MemoryWriteEventInput } from "../provider.js";
import { MemoryAuthorityError } from "./types.js";

const propositionSchema = z
  .object({
    content: z.string().min(1).max(4000),
    evidenceText: z.string().min(1).max(8000),
    relation: z.enum(["new", "supersedes", "conflicts", "supports"]),
    targetIds: z.array(z.string().min(1)).max(8)
  })
  .strict();
const proposalSchema = z.object({ propositions: z.array(z.unknown()).max(12) }).strict();
/** Model proposes meaning; Host verifies source selection, ownership and persistence. No rule fallback. */
export class SemanticMemoryPolicy {
  readonly semanticOnly = true;
  constructor(
    private readonly reasoner: MemoryExtractionReasoner,
    private readonly readPrior: (scope: string, text: string) => Promise<MemoryEvent[]>,
    private readonly options: LlmMemoryExtractorOptions = {},
    private readonly jobs?: AuthorityQuery
  ) {}
  getStatus(): MemoryExtractorStatus {
    return {
      mode: "llm",
      active: this.options.providerConfigured ? "llm" : "disabled",
      enabled: Boolean(this.options.providerConfigured),
      provider: this.options.providerName ?? this.reasoner.name ?? "reasoning-route",
      fallbackUsed: false,
      ...(this.options.providerConfigured ? {} : { error: "MEMORY_SEMANTIC_PROVIDER_UNAVAILABLE" })
    };
  }
  async build(input: MemoryIngestionInput): Promise<MemoryIngestionResult> {
    const source = input.groundedSource;
    if (!source || source.selectedText !== input.userMessage)
      throw new MemoryAuthorityError("MEMORY_SEMANTIC_SOURCE_REQUIRED");
    if (this.jobs) return this.buildDurable(input);
    return this.evaluate(input);
  }
  private async buildDurable(input: MemoryIngestionInput): Promise<MemoryIngestionResult> {
    const db = this.jobs!;
    const jobId = input.idempotencyKey;
    if (!jobId) throw new MemoryAuthorityError("MEMORY_SEMANTIC_JOB_ID_REQUIRED");
    const { commitSeq: _sequence, ...digestSource } = input.groundedSource!;
    const digest = lineageDigest(
      canonicalLineageJson({
        scope: input.scope,
        source: digestSource,
        policy: "memory.semantic.v1",
        ...(input.reassessment ? { reassessment: input.reassessment } : {})
      })
    );
    await db.query(
      `insert into memory_semantic_jobs(scope,job_id,source_digest,source_ref,status,input_context) values($1,$2,$3,$4,'pending',$5::jsonb) on conflict do nothing`,
      [
        input.scope,
        jobId,
        digest,
        input.groundedSource!.parent,
        JSON.stringify(input.dialogueContext ?? [])
      ]
    );
    await db.query(
      `update memory_semantic_jobs set status='terminal_failed',error_code='MEMORY_SEMANTIC_RETRY_EXHAUSTED',lease_owner=null,lease_until=null where scope=$1 and job_id=$2 and status='processing' and attempts>=8 and lease_until<=now()`,
      [input.scope, jobId]
    );
    const old = (
      await db.query("select * from memory_semantic_jobs where scope=$1 and job_id=$2", [
        input.scope,
        jobId
      ])
    ).rows[0]!;
    if (old["source_digest"] !== digest)
      throw new MemoryAuthorityError("MEMORY_SEMANTIC_SOURCE_CONFLICT");
    if (old["status"] === "complete") return old["result"] as MemoryIngestionResult;
    if (old["status"] === "terminal_failed")
      throw new MemoryAuthorityError("MEMORY_SEMANTIC_RETRY_EXHAUSTED");
    const owner = randomUUID();
    const claimed = await db.query(
      `update memory_semantic_jobs set status='processing',attempts=attempts+1,lease_owner=$3,lease_until=now()+interval '40 seconds',updated_at=now()
      where scope=$1 and job_id=$2 and attempts<8 and
      ((status in ('pending','retryable_failed') and (next_attempt_at is null or next_attempt_at<=now())) or (status='processing' and lease_until<=now())) returning attempts`,
      [input.scope, jobId, owner]
    );
    if (!claimed.rows.length) throw new MemoryAuthorityError("MEMORY_SEMANTIC_JOB_NOT_DUE");
    const started = Date.now();
    try {
      const result = await this.evaluate(
        {
          ...input,
          dialogueContext: (old["input_context"] ?? []) as MemoryIngestionInput["dialogueContext"]
        },
        owner
      );
      const done = await db.query(
        `update memory_semantic_jobs set status='complete',result=$4,lease_owner=null,lease_until=null,error_code=null,duration_ms=$5,updated_at=now()
        where scope=$1 and job_id=$2 and lease_owner=$3 and lease_until>now() returning job_id`,
        [input.scope, jobId, owner, result, Date.now() - started]
      );
      if (!done.rows.length) throw new MemoryAuthorityError("MEMORY_SEMANTIC_LEASE_LOST");
      return result;
    } catch (error) {
      const code =
        error instanceof MemoryAuthorityError ? error.code : "MEMORY_SEMANTIC_EVALUATION_FAILED";
      await db.query(
        `update memory_semantic_jobs set status=case when attempts>=8 then 'terminal_failed' else 'retryable_failed' end,error_code=$4,next_attempt_at=now()+interval '30 seconds',lease_owner=null,lease_until=null,duration_ms=$5,updated_at=now()
        where scope=$1 and job_id=$2 and lease_owner=$3`,
        [input.scope, jobId, owner, code, Date.now() - started]
      );
      throw error;
    }
  }
  private async evaluate(
    input: MemoryIngestionInput,
    owner?: string
  ): Promise<MemoryIngestionResult> {
    const source = input.groundedSource!;
    if (!this.options.providerConfigured)
      throw new MemoryAuthorityError("MEMORY_SEMANTIC_PROVIDER_UNAVAILABLE");
    let characters = 0;
    const loadPrior = () => this.readPrior(input.scope, input.userMessage);
    const related =
      source.authority.principal.state === "RESOLVED" &&
      source.authority.binding.state === "RESOLVED" &&
      source.authority.audience.kind === "PRIVATE"
        ? await (this.options.withSourceContext
            ? this.options.withSourceContext(source, input.scope, loadPrior)
            : loadPrior())
        : [];
    const prior = related
      .filter((event) => {
        const lineage = event.lineage;
        return (
          event.scope === input.scope &&
          lineage?.state === "GROUNDED" &&
          "authority" in lineage &&
          lineage.authority.principal.state === "RESOLVED" &&
          lineage.authority.binding.state === "RESOLVED" &&
          source.authority.principal.state === "RESOLVED" &&
          source.authority.binding.state === "RESOLVED" &&
          lineage.authority.audience.kind === "PRIVATE" &&
          lineage.authority.principal.namespace === source.authority.principal.namespace &&
          lineage.authority.principal.actorId === source.authority.principal.actorId &&
          lineage.authority.binding.personId === source.authority.binding.personId
        );
      })
      .slice(0, 64)
      .filter((event) => {
        if (characters + event.content.length > 24000) return false;
        characters += event.content.length;
        return true;
      });
    const call = () =>
      this.reasoner.generateReasoning(
        {
          temperature: 0,
          maxTokens: 2048,
          messages: [
            {
              role: "system",
              content:
                INSTRUCTION +
                (input.reassessment
                  ? ` Reassess ONLY this original proposition: ${JSON.stringify(input.reassessment.proposition)}. Return exactly one proposition with that identical content and a newly evaluated relation/targetIds based on the current prior and the original source. Do not produce other propositions from the source. If current prior already represents the same fact, propose supports. Source event order matters: an older source cannot retract a later current assertion. Preserve conflict or uncertainty rather than treating worker completion order as user chronology.`
                  : "")
            },
            {
              role: "user",
              content: JSON.stringify({
                source: source.selectedText,
                sourceAt: source.recordedAt,
                sourceCommitSeq: source.commitSeq ?? null,
                origin: source.origin,
                dialogueContext: input.dialogueContext ?? [],
                prior: prior.map((e) => ({
                  id: e.id,
                  content: e.content,
                  sourceAt: e.recordedAt,
                  sourceCommitSeq:
                    e.lineage?.state === "GROUNDED" && "sourceTime" in e.lineage
                      ? (e.lineage.sourceTime.commitSeq ?? null)
                      : null,
                  state: e.metadata["knowledgeState"]
                }))
              })
            }
          ]
        },
        { signal: AbortSignal.timeout(20_000) }
      );
    const output = this.options.withSourceContext
      ? await this.options.withSourceContext(source, input.scope, call)
      : await call();
    if (this.jobs)
      await this.jobs.query(
        `update memory_semantic_jobs set provider_model=$3,token_usage=$4 where scope=$1 and job_id=$2 and status='processing' and lease_owner=$5`,
        [
          input.scope,
          input.idempotencyKey,
          output.model ?? null,
          output.tokenUsage ?? null,
          owner ?? null
        ]
      );
    if (output.finishReason === "length" || output.finishReason === "content_filter")
      throw new MemoryAuthorityError("MEMORY_SEMANTIC_OUTPUT_INCOMPLETE");
    const text = (output.answer?.trim() || output.reasoning?.trim() || "").replace(
      /^```(?:json)?\s*|\s*```$/gu,
      ""
    );
    const parsed = proposalSchema.parse(JSON.parse(text)).propositions;
    const proposals = parsed.map((p) => propositionSchema.safeParse(p));
    const invalid: Array<{ index: number; code: string }> = [];
    if (
      input.reassessment &&
      (proposals.length !== 1 ||
        !proposals[0]!.success ||
        proposals[0]!.data.content !== input.reassessment.proposition)
    )
      throw new MemoryAuthorityError("MEMORY_REASSESSMENT_UNRESOLVED");
    const events: MemoryWriteEventInput[] = [];
    for (const [index, parsed] of proposals.entries()) {
      if (!parsed.success) {
        invalid.push({ index, code: "MEMORY_SEMANTIC_PROPOSITION_INVALID" });
        continue;
      }
      const p = parsed.data;
      if (!source.selectedText.includes(p.evidenceText)) {
        invalid.push({ index, code: "MEMORY_SEMANTIC_EVIDENCE_NOT_SELECTED" });
        continue;
      }
      if (
        (p.relation === "new") !== (p.targetIds.length === 0) ||
        p.targetIds.some((id) => !prior.some((e) => e.id === id && e.scope === input.scope))
      ) {
        invalid.push({ index, code: "MEMORY_SEMANTIC_TARGET_NOT_PRESENTED" });
        continue;
      }
      const start = source.selectedText.indexOf(p.evidenceText);
      if (source.selectedText.indexOf(p.evidenceText, start + 1) !== -1) {
        invalid.push({ index, code: "MEMORY_SEMANTIC_EVIDENCE_SELECTION_AMBIGUOUS" });
        continue;
      }
      events.push({
        scope: input.scope,
        content: p.content,
        kind: p.relation === "supersedes" ? "correction" : "fact",
        ...(p.relation === "supersedes"
          ? { supersedes: p.targetIds }
          : p.relation === "conflicts"
            ? { conflicts: p.targetIds }
            : p.relation === "supports"
              ? { supports: p.targetIds }
              : {}),
        metadata: {
          semanticPolicy: "memory.semantic.v1",
          evidenceSelection: {
            unit: "UNICODE_CODE_POINT",
            start: Array.from(source.selectedText.slice(0, start)).length,
            end: Array.from(source.selectedText.slice(0, start + p.evidenceText.length)).length
          },
          model: output.model ?? null
        },
        conversationId: input.conversationId ?? null,
        sourceTurnIds: input.userMessageId ? [input.userMessageId] : []
      });
    }
    return {
      turnKind: "normal",
      events,
      ...(invalid.length ? { rejectedPropositions: invalid } : {}),
      ...(events.length ? {} : { skippedReason: "semantic-no-long-term-value" })
    };
  }
}
const INSTRUCTION = `Evaluate every source for useful long-term memory. Return ONLY JSON {"propositions":[{"content":"a single proposition","evidenceText":"unique exact contiguous source quote","relation":"new|supersedes|conflicts|supports","targetIds":[]}]}. You decide semantics, not permissions. Split independent propositions even in the same message. Retain future useful facts, preferences, goals, decisions, unresolved issues and confirmed experiences; ignore transient chatter. Content may restate meaning but must be supported by the exact selected evidence. dialogueContext is bounded preceding conversation for interpreting ellipsis and pronouns ONLY. Assistant questions are NOT user assertions. An elliptical user answer may assert the answer to the preceding question; cite ONLY a unique exact quote from source, never dialogueContext. Do not infer unsupported missing detail. User assertions are self reports, not independently verified truth. Never treat assistant plans or prose as actual execution. Never treat quotes, hypotheticals, questions or third-party claims as personal confirmations. Mixed quotation does not invalidate other asserted facts. For an explicit natural correction (including pronouns and multilingual references), supersedes only the specific prior proposition(s) actually retracted. Conflicting assertions without explicit retraction use conflicts and keep both sources; repeated equivalent facts use supports. Do not use word overlap as proof of equivalence. Targets must be presented prior IDs. If ambiguous or no long-term value return an empty array. Do not invent dates, people, permissions or certainty.`;
