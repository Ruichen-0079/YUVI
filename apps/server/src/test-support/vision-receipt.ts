import type { VisionReceiptAdmission } from "../vision-receipt-admission.js";

/** Explicit test-only host seam; production AppContext always uses the Journal facade. */
export function createTestVisionReceiptAdmission(): VisionReceiptAdmission {
  return {
    async admit() {}
  };
}
