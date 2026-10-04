import {
  PostgresContextUseRepository,
  contextManifestId,
  contextUseDigest
} from "@companion/memory";
import type { ContextManifest, ContextExposure } from "@companion/protocol";
import type { ProviderTaskDescriptor } from "@companion/providers";
import type { JournalRepository } from "@companion/journal";
/** Historical evidence writer only. Runtime/A4 and native owners supply the captured meaning. */
export class HostContextUse {
  private repository: PostgresContextUseRepository | null = null;
  private readonly contextBases = new WeakMap<object, ContextManifest>();
  constructor(
    private readonly journal: JournalRepository | null,
    private readonly namespace: string
  ) {}
  setRepository(repository: PostgresContextUseRepository | null) {
    this.repository = repository;
  }
  async capture(task: ProviderTaskDescriptor): Promise<{ manifestId: string; exposureId: string }> {
    const repository = this.repository;
    if (!repository) throw Error("Required durable context-use evidence unavailable.");
    if (task.context?.isCurrent && !task.context.isCurrent())
      throw Error("Context consumer is no longer current.");
    const pending = task.contextUse;
    if (pending?.verifyCurrent && !(await pending.verifyCurrent()))
      throw Error("Current context dependency is stale or unavailable.");
    let base = pending ? this.contextBases.get(pending) : undefined;
    if (!base) {
      const refs = task.context?.cause ? [JSON.stringify(task.context.cause)] : [];
      base = {
        version: "context-use-manifest.v1",
        namespace: this.namespace,
        executionId: task.context?.executionId ?? task.operationId,
        assemblyOrdinal: task.assemblyOrdinal ?? "1",
        scope: task.context?.scope ?? "host-provider-operation",
        ...(pending?.manifest ?? {
          assemblyVersion: "input-only.v1",
          selectionVersion: "NOT_USED",
          enumeration: "NOT_USED",
          sources: [
            {
              owner: "INPUT",
              reference: task.operationId,
              revision: null,
              digest: task.inputDigest,
              availability: "NOT_RETAINED",
              revisionKind: "OBSERVED_SNAPSHOT",
              selection: "SELECTED",
              reason: "No A4 context consumed by this operation",
              roots: refs
            },
            {
              owner: "PROFILE",
              reference: "profile:NOT_USED",
              revision: null,
              digest: null,
              availability: "NOT_USED",
              revisionKind: "NOT_USED",
              selection: "OMITTED",
              reason: "No synthesized Profile input",
              roots: []
            }
          ],
          blocks: [],
          stable: { version: "NOT_USED", digest: contextUseDigest(null) },
          volatile: { version: "input-only.v1", digest: task.inputDigest }
        })
      };
      if (task.context?.cause) {
        const receipt = await this.journal?.get(task.context.cause);
        if (!receipt) throw Error("Historical Journal source unavailable.");
        base.sources = [
          ...base.sources,
          {
            owner: "JOURNAL",
            reference: JSON.stringify(task.context.cause),
            revision: task.context.cause.eventId,
            digest: null,
            availability: "AVAILABLE",
            revisionKind: "NATIVE",
            selection: "SELECTED",
            reason: "Immutable committed execution cause; unresolved identities remain in receipt",
            semanticReferences: [
              ...receipt.authority.payloads.map((p) => JSON.stringify(p)),
              ...(["RECEIPT", "OUTCOME", "DECISION"].includes(receipt.command.kind) &&
              "evidenceSelectors" in receipt.command.data
                ? (receipt.command.data.evidenceSelectors as unknown[]).map((s) =>
                    JSON.stringify(s)
                  )
                : [])
            ],
            roots: []
          }
        ];
      }
      if (pending) this.contextBases.set(pending, base);
    }
    const exposure: ContextExposure = {
      version: "context-exposure.v1",
      boundary: "PREPARED_FOR_USE",
      manifestId: contextManifestId(base),
      consumerOperationSlot: `${task.operation}:${task.operationId}`,
      exposureOrdinal: "1",
      ...task.exposure
    };
    const admitted = await repository.admit(base, exposure);
    if (!admitted.exposureId) throw Error("Required context exposure missing.");
    if (task.context?.isCurrent && !task.context.isCurrent())
      throw Error("Context consumer expired during evidence admission.");
    return { manifestId: admitted.manifestId, exposureId: admitted.exposureId };
  }
}
