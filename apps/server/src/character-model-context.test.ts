import { describe, expect, it } from "vitest";
import {
  createCharacterAbi2DContext,
  CHARACTER_ABI_2D_VERSION
} from "@companion/character-abi/v2d";
import { renderCharacterModelContext } from "./character-model-context.js";

describe("readable model context", () => {
  it("uses one local clock without projecting the audit episode index or mutating canonical data", () => {
    const context = createCharacterAbi2DContext({
      abiVersion: CHARACTER_ABI_2D_VERSION,
      sections: [
        {
          kind: "IDENTITY",
          state: "KNOWN",
          summary: "Alice",
          provenanceReferences: ["INTERNAL_REFERENCE"]
        },
        {
          kind: "TEMPORAL_CONTEXT",
          state: "KNOWN",
          summary:
            "ISO timestamp: 2026-10-07T16:00:00Z\nTimezone: Asia/Shanghai\nLocal date: 2026-10-08\nLocal date-time: 2026-10-08 00:00\nElapsed since last interaction: 2 minutes\nRecent episodes:\n- INTERNAL_EPISODE_INDEX"
        }
      ]
    });
    const snapshot = JSON.stringify(context);
    const rendered = renderCharacterModelContext(context).background;
    expect(rendered).toContain("Alice");
    expect(rendered).toContain("Timezone: Asia/Shanghai");
    expect(rendered).toContain("Local date-time: 2026-10-08 00:00");
    expect(rendered).toContain("Elapsed since last interaction: 2 minutes");
    expect(rendered).not.toContain("ISO timestamp:");
    expect(rendered).not.toContain("Local date:");
    expect(rendered).not.toContain("INTERNAL_EPISODE_INDEX");
    expect(rendered).not.toContain("INTERNAL_REFERENCE");
    expect(JSON.stringify(context)).toBe(snapshot);
  });
});
