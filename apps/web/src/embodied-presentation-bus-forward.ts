import {
  AccountedPresentationRequestSchema,
  createEmbodiedPresentationRequest
} from "@companion/protocol";
import type { RuntimeEvent } from "./api/client.js";
import type { CompanionBusMessage } from "./companion-bus.js";

export type EmbodiedPresentationBusPost = (
  message: Extract<
    CompanionBusMessage,
    { kind: "embodied-presentation-request" | "accounted-presentation-request" }
  >
) => void;

/**
 * Forward one Runtime Presentation request onto CompanionBus.
 * Fail-closed: unknown event types and malformed payloads are ignored.
 */
export function forwardEmbodiedPresentationRequest(
  event: Pick<RuntimeEvent, "type" | "payload">,
  post: EmbodiedPresentationBusPost
): void {
  if (event.type !== "runtime.embodied.presentation.request") {
    return;
  }
  const accounted = AccountedPresentationRequestSchema.safeParse(event.payload);
  if (accounted.success) {
    post({ kind: "accounted-presentation-request", envelope: accounted.data });
    return;
  }
  try {
    const request = createEmbodiedPresentationRequest(event.payload);
    post({ kind: "embodied-presentation-request", request });
  } catch {
    // Product/dashboard transport must fail closed on malformed Runtime input.
  }
}
