import type {
  VoiceControlReceiptAdmission,
  VoiceControlReceiptInput
} from "../voice-control-receipt-admission.js";

export function createTestVoiceControlReceiptAdmission(
  onAdmit?: (input: VoiceControlReceiptInput) => void | Promise<void>
): VoiceControlReceiptAdmission {
  return {
    async admit(input) {
      await onAdmit?.(input);
    }
  };
}
