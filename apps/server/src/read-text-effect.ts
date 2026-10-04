import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  EffectDispatcher,
  effectIntentId,
  EffectIdentitySnapshotSchema,
  EFFECT_DELIVERY_CONTRACTS,
  type EffectIntentAdmissionPort,
  type EffectDispatchStore,
  type EffectIntent,
  type EffectCausalReader
} from "@companion/effects";
import type { JournalEventRef } from "@companion/protocol";
import type { ServerMcpToolResult } from "./mcp-client.js";

export type ReadTextEffectInput = {
  path: string;
  logicalKey: string;
  scope: string;
  executionId: string;
  cause: JournalEventRef;
  expiresAt: string;
  isCurrent(): boolean;
  signal?: AbortSignal | undefined;
};
/** The active local adapter: file contents exist only in the transient Runtime return value. */
export async function readAuthorizedLocalText(
  path: string,
  signal: AbortSignal
): Promise<ServerMcpToolResult> {
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64_000)
      throw Error("Authorized text must be a bounded regular file.");
    const bytes = Buffer.alloc(64_001);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    signal.throwIfAborted();
    if (bytesRead > 64_000) throw Error("Authorized text exceeds limit.");
    return {
      isError: false,
      content: [
        {
          type: "text",
          text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))
        }
      ]
    };
  } finally {
    await file.close();
  }
}
/** One AppContext-owned adapter/worker and host-only volatile grants. Restart does NOT restore access. */
export class HostReadTextEffects {
  private readonly grants = new Map<string, ReadTextEffectInput>();
  readonly dispatcher: EffectDispatcher | null;
  private accepting = true;
  captureContext?:
    | ((key: string, input: unknown) => Promise<{ manifestId: string; exposureId: string }>)
    | undefined;
  constructor(
    private readonly admission: EffectIntentAdmissionPort,
    store: EffectDispatchStore | null,
    private readonly journal: EffectCausalReader | null
  ) {
    const current = (i: EffectIntent) => {
      const g = this.grants.get(i.intentId);
      return (
        !!g &&
        this.accepting &&
        !g.signal?.aborted &&
        g.isCurrent() &&
        i.request.executionId === g.executionId &&
        i.request.scope === g.scope &&
        (i.request.payload as { path: string }).path === g.path
      );
    };
    const grants = this.grants;
    this.dispatcher = store
      ? new EffectDispatcher(
          store,
          [
            {
              contractRef: "yuvi.read-text.v1",
              adapter: EFFECT_DELIVERY_CONTRACTS["yuvi.read-text.v1"].adapter,
              isCurrent: current,
              async invoke(i, _a, signal) {
                // No provider selection, MCP network transport, or publication is hidden in this adapter.
                const grantSignal = grants.get(i.intentId)?.signal;
                const result = await readAuthorizedLocalText(
                  (i.request.payload as { path: string }).path,
                  grantSignal ? AbortSignal.any([signal, grantSignal]) : signal
                );
                return {
                  evidence: {
                    certainty: "APPLIED",
                    layer: "LOCAL_READ_RETURNED",
                    reason: "RETURNED",
                    remoteEffectId: null
                  },
                  transientResult: result
                };
              }
            }
          ],
          30_000,
          4,
          true
        )
      : null;
  }
  start() {
    this.dispatcher?.start();
  }
  async execute(raw: ReadTextEffectInput): Promise<ServerMcpToolResult> {
    const g = { ...raw, cause: { ...raw.cause } };
    if (!this.accepting || !this.dispatcher || !this.journal)
      throw Error("Durable read-text effects unavailable.");
    const receipt = await this.journal.get(g.cause);
    if (!receipt || receipt.command.kind !== "RECEIPT")
      throw Error("Committed read-text cause unavailable.");
    const { principal, subjects, binding, audience, disclosurePolicy } = receipt.authority;
    const identity = EffectIdentitySnapshotSchema.parse({
      principal,
      subjects,
      binding,
      audience,
      disclosurePolicy
    });
    const isCurrent = () => this.accepting && !g.signal?.aborted && g.isCurrent();
    const id = effectIntentId("yuvi.read-text.v1", g.logicalKey);
    if (this.grants.has(id)) throw Error("Read-text logical work already has a volatile owner.");
    const contextUse = await this.captureContext?.(g.logicalKey, { path: g.path });
    // Install before COMMIT can make pending work visible to the background worker.
    this.grants.set(id, g);
    try {
      const intent = await this.admission.admit(
        {
          contractRef: "yuvi.read-text.v1",
          logicalKey: g.logicalKey,
          scope: g.scope,
          audience: identity.audience,
          payload: { path: g.path, ...(contextUse ? { contextUse } : {}) },
          causalRefs: [g.cause],
          executionId: g.executionId,
          expiresAt: g.expiresAt
        },
        {
          snapshot: {
            policyVersion: "runtime-read-text.v1",
            authorityVersion: `runtime:${g.executionId}`,
            scope: g.scope,
            identity,
            permissions: ["RUNTIME_AUTHORIZED_PATH_READ"],
            allowed: true
          },
          isCurrent
        }
      );
      if (intent.decision !== "ADMITTED" || intent.workState !== "PENDING")
        throw Error("Read-text work is not pending.");
      const abort = () => {
        void this.dispatcher!.cancel(intent.intentId).catch(() => undefined);
      };
      g.signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await this.dispatcher.run(intent.intentId);
        if (!isCurrent() || !result.recorded || result.transientResult === undefined)
          throw Error("Read-text result unavailable or stale.");
        // Adapter is the only producer of this transient shape; it is not loaded from durable JSON.
        return result.transientResult as ServerMcpToolResult;
      } finally {
        g.signal?.removeEventListener("abort", abort);
        this.grants.delete(intent.intentId);
      }
    } finally {
      this.grants.delete(id);
    }
  }
  async shutdown(graceMs = 2000) {
    this.accepting = false;
    return this.dispatcher?.shutdown(graceMs) ?? { drained: true };
  }
}
