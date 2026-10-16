import { describe, expect, it } from "vitest";
import { observationContextText, structuredVisualEvidence } from "./observation-evidence.js";
describe("independently budgeted Provider reports", () => {
  it("retains scene, objects, uncertainty and the OCR tail when OCR dominates the report", () => {
    const fields = structuredVisualEvidence({
      text: "BEGIN_" + "OCR ".repeat(7000) + "_END",
      sceneSummary: "a red stamp on a document",
      objects: ["stamp", "date 2031-04-17"],
      confidence: 0.71
    });
    const context = observationContextText(fields);
    expect(context.length).toBeLessThanOrEqual(4000);
    const parsed = JSON.parse(context);
    expect(parsed.text).toContain("BEGIN_");
    expect(parsed.text).toContain("_END");
    expect(parsed.textTruncated).toBe(true);
    expect(parsed.sceneSummary).toBe("a red stamp on a document");
    expect(parsed.objects).toContain("date 2031-04-17");
    expect(parsed.confidence).toBe(0.71);
  });
  it("bounds serialized escapes without letting OCR erase independently returned fields", () => {
    const context = observationContextText(
      structuredVisualEvidence({
        text: '\\"'.repeat(16000),
        sceneSummary: '\\"'.repeat(2000),
        objects: ['\\"'.repeat(160)],
        confidence: NaN
      })
    );
    expect(context.length).toBeLessThanOrEqual(4000);
    const fields = JSON.parse(context);
    expect(fields.sceneSummary.length).toBeGreaterThan(0);
    expect(fields.objects).toHaveLength(1);
    expect(fields.confidence).toBeNull();
    expect(fields.epistemicState).toBe("UNTRUSTED_PROVIDER_REPORT");
  });
  it("fits the persisted JSON budget for large multilingual or escaped reports and keeps their tails", () => {
    for (const unit of ["中", "\u0001", '"\\', "🧭"]) {
      const report = structuredVisualEvidence({
        text: "HEAD" + unit.repeat(64000) + "TAIL",
        sceneSummary: unit.repeat(64000),
        objects: Array.from({ length: 100 }, () => unit.repeat(1000))
      });
      expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(80000);
      expect(report.text).toContain("HEAD");
      expect(report.text).toContain("TAIL");
      expect(report.text).toContain("omitted");
    }
  });
});
