import { describe, expect, it } from "vitest";
import {
  deriveCompanionRendererPresentation,
  isCompanionRendererPresentation,
  type CompanionRendererPresentation
} from "./companion-presentation-projection.js";

const model = { id: "hiyori", name: "Hiyori Momose" } as const;

describe("Companion renderer presentation projection", () => {
  it("keeps a selected model as a request until Lumi proves renderer readiness", () => {
    expect(deriveCompanionRendererPresentation("loading", null, model)).toEqual({
      status: "loading",
      requestedModel: model
    });
    expect(deriveCompanionRendererPresentation("failed", null, model)).toEqual({
      status: "failed",
      requestedModel: model
    });
    expect(deriveCompanionRendererPresentation("ready", null, model)).toEqual({
      status: "unavailable"
    });
  });

  it("exposes active identity only after the controller reports ready", () => {
    expect(deriveCompanionRendererPresentation("ready", model)).toEqual({
      status: "ready",
      activeModel: model
    });
    expect(deriveCompanionRendererPresentation("loading", null)).toEqual({ status: "loading" });
    expect(deriveCompanionRendererPresentation("failed", null)).toEqual({ status: "failed" });
  });

  it("keeps discovery uncertainty distinct from no model and renderer failure", () => {
    expect(deriveCompanionRendererPresentation(null, null)).toEqual({ status: "unavailable" });
    const noModel: CompanionRendererPresentation = { status: "no_model" };
    expect(noModel).toEqual({ status: "no_model" });
    expect(isCompanionRendererPresentation(noModel)).toBe(true);
    expect(isCompanionRendererPresentation({ status: "unavailable" })).toBe(true);
  });

  it("rejects malformed or semantically contradictory cross-window state", () => {
    expect(isCompanionRendererPresentation({ status: "ready", activeModel: model })).toBe(true);
    expect(isCompanionRendererPresentation({ status: "ready" })).toBe(false);
    expect(
      isCompanionRendererPresentation({ status: "ready", activeModel: { id: "", name: "Hiyori" } })
    ).toBe(false);
    expect(
      isCompanionRendererPresentation({ status: "loading", activeModel: model })
    ).toBe(false);
    expect(isCompanionRendererPresentation({ status: "working" })).toBe(false);
  });
});
