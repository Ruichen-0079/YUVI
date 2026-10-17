import { describe, it, expect } from "vitest";
import { coverageSelection } from "./coverage.js";
describe("demand allocation without false coverage from incidental overlap", () => {
  it("reserves each preferred candidate before lower-ranked overlapping neighbors", () => {
    expect(
      coverageSelection(
        ["date", "framework", "owner"],
        [
          { id: "date", ranking: ["date", "framework"] },
          { id: "framework", ranking: ["framework", "owner"] },
          { id: "owner", ranking: ["owner", "framework"] }
        ],
        3
      )
    ).toEqual(["date", "framework", "owner"]);
  });
  it("deduplicates exact shared preferred evidence and honors the final bound", () => {
    expect(
      coverageSelection(
        ["both", "a", "b"],
        [
          { id: "a", ranking: ["both", "a"] },
          { id: "b", ranking: ["both", "b"] }
        ],
        2
      )
    ).toEqual(["both", "a"]);
  });
});
