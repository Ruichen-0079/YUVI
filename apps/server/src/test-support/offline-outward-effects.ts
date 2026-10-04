/** Unit composition double only. Durable/fault suites always import the real host. */
import type { ProviderAccountingPort } from "@companion/providers";
import type { ReplyPublicationAdmission } from "@companion/memory";
export class HostOutwardEffects implements ProviderAccountingPort {
  readonly admitReplyPublications: ReplyPublicationAdmission = async () => {};
  constructor(..._dependencies: unknown[]) {}
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
