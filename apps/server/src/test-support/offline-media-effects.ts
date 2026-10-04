/** Unit-only transport composition. Real durable media acceptance uses HostMediaEffects. */
import { randomUUID } from "node:crypto";
import type { TTSInput, ProviderRegistry } from "@companion/providers";
export class HostMediaEffects {
  constructor(
    _pool: unknown,
    _outward: unknown,
    private readonly providers: () => ProviderRegistry
  ) {}
  invalidateAll() {}
  seal() {}
  generation() {
    return randomUUID();
  }
  revoke() {}
  interruptSession() {
    return undefined;
  }
  presentationTarget() {
    return undefined;
  }
  async sealWhole(_text: string, _session: string) {
    return { segmentId: randomUUID(), generation: "unit-only" };
  }
  async synthesize(_segment: unknown, input: TTSInput, signal: AbortSignal) {
    return this.providers().getTTSProvider().synthesizeSpeech(input, { signal });
  }
}
export class HostPresentationEffects {
  constructor(..._args: unknown[]) {}
  invalidateAll() {}
  seal() {}
  async dispatch() {}
  async report() {
    return false;
  }
}
