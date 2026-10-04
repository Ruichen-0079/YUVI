import { HostContextUse } from "../context-use.js";
import type { PostgresContextUseRepository } from "@companion/memory";
import type { JournalRepository } from "@companion/journal";
import {
  currentProviderWorkContext,
  describeExposure,
  providerInputDigest
} from "@companion/providers";
/** Unit composition double only. Durable/fault suites always import the real host. */
import type { ProviderAccountingPort } from "@companion/providers";
import type { ReplyPublicationAdmission } from "@companion/memory";
export class HostOutwardEffects implements ProviderAccountingPort {
  readonly admitReplyPublications: ReplyPublicationAdmission = async () => {};
  private readonly contextUse: HostContextUse;
  constructor(...dependencies: unknown[]) {
    this.contextUse = new HostContextUse(
      dependencies[3] as JournalRepository | null,
      String(dependencies[4] ?? "unit-only")
    );
  }
  setContextUseRepository(repository: PostgresContextUseRepository | null) {
    this.contextUse.setRepository(repository);
  }
  async captureOperationContext(operationId: string, _operation: string, input: unknown) {
    const context = currentProviderWorkContext();
    return this.contextUse.capture({
      operationId,
      operation: "read_text_file",
      inputDigest: providerInputDigest(input),
      configurationRef: "offline-tool-composition",
      routingPlan: [],
      context,
      contextUse: context?.contextUse,
      assemblyOrdinal: String(context?.assemblyOrdinal ?? 1),
      exposure: describeExposure(input, context?.contextUse)
    });
  }
  seal() {}
  async operationCause() {
    return { kind: "JOURNAL_EVENT" as const, namespace: "unit-only", eventId: "unit-only" };
  }
  registerTarget(..._input: unknown[]) {
    return () => {};
  }
  async publish(input: { write: () => Promise<void> }) {
    await input.write();
  }
  async invoke<T>(
    _task: unknown,
    _leaf: unknown,
    call: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ) {
    return call(signal);
  }
  async *stream<T>(
    _task: unknown,
    _leaf: unknown,
    call: (signal?: AbortSignal) => AsyncIterable<T>,
    signal?: AbortSignal
  ) {
    yield* call(signal);
  }
}
