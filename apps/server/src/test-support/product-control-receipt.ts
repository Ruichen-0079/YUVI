import type { ProductControlReceiptAdmission } from "../product-control-receipt-admission.js";

export function createTestProductControlReceiptAdmission(): ProductControlReceiptAdmission {
  return {
    async admit() {
      return { kind: "JOURNAL_EVENT", namespace: "test", eventId: "test-receipt" };
    }
  };
}
