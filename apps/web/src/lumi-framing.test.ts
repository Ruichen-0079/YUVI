import { describe, expect, it } from "vitest";
import {
  buildFramingDiagnostics,
  computeFullBodyFit,
  computeLumiFramingTransform,
  computePortraitHeadFit,
  isHeadFullyVisible,
  isUniformPixelScale,
  LUMI_FULL_BODY_FIT,
  LUMI_PORTRAIT_HEAD_BOUNDS,
  LUMI_PORTRAIT_MAX_HORIZONTAL_BLEED_PX,
  LUMI_PORTRAIT_MARGINS,
  pixelsPerModelUnit,
  projectHeadBoundsToViewportPx,
  projectModelToViewportPx,
  sameFitKey,
  uniformScaleToNdc
} from "./lumi-framing.js";
import { getLumiFramingZoom, getLumiRenderMetrics } from "./lumi-cubism-model.js";

describe("uniform scale contract", () => {
  it("maps one uniform pixel scale to NDC components that keep X/Y pixels equal", () => {
    const viewports = [
      [280, 720],
      [480, 480],
      [900, 400],
      [320, 480],
      [1200, 1600]
    ] as const;
    for (const [w, h] of viewports) {
      const { ndcScaleX, ndcScaleY } = uniformScaleToNdc(100, w, h);
      expect((ndcScaleX * w) / 2).toBeCloseTo(100, 6);
      expect((ndcScaleY * h) / 2).toBeCloseTo(100, 6);
      // NDC components differ on non-square viewports — that is intentional.
      if (w !== h) {
        expect(ndcScaleX).not.toBeCloseTo(ndcScaleY, 6);
      }
    }
  });

  it("never uses independent character scaleX/scaleY for portrait or full-body", () => {
    const cases = [
      { w: 280, h: 720 },
      { w: 900, h: 400 },
      { w: 480, h: 720 },
      { w: 1200, h: 1600 }
    ];
    for (const { w, h } of cases) {
      for (const framing of ["half", "full"] as const) {
        const transform = computeLumiFramingTransform(framing, w, h, 2, 2);
        expect(isUniformPixelScale(transform)).toBe(true);
        const px = pixelsPerModelUnit(transform);
        expect(px.x).toBeCloseTo(px.y, 6);
        expect(px.x).toBeCloseTo(transform.uniformScale, 6);
      }
    }
  });
});

describe("portrait framing", () => {
  const modelWidth = 2;
  const modelHeight = 2;

  const viewports = [
    { w: 280, h: 720, name: "narrow-tall" },
    { w: 320, h: 480, name: "min" },
    { w: 480, h: 720, name: "default" },
    { w: 480, h: 480, name: "square" },
    { w: 900, h: 400, name: "wide-short" },
    { w: 1200, h: 1600, name: "large" }
  ];

  it("keeps crown and chin vertically safe while allowing bounded horizontal cover", () => {
    for (const viewport of viewports) {
      const fit = computePortraitHeadFit({
        viewportWidth: viewport.w,
        viewportHeight: viewport.h,
        modelWidth,
        modelHeight,
        headBounds: LUMI_PORTRAIT_HEAD_BOUNDS
      });
      const rect = projectHeadBoundsToViewportPx(LUMI_PORTRAIT_HEAD_BOUNDS, fit);
      expect(rect.top).toBeGreaterThanOrEqual(LUMI_PORTRAIT_MARGINS.top - 1.5);
      expect(rect.bottom).toBeLessThanOrEqual(
        viewport.h - LUMI_PORTRAIT_MARGINS.bottom + 1.5
      );
      expect(rect.left).toBeGreaterThanOrEqual(-LUMI_PORTRAIT_MAX_HORIZONTAL_BLEED_PX - 1.5);
      expect(rect.right).toBeLessThanOrEqual(
        viewport.w + LUMI_PORTRAIT_MAX_HORIZONTAL_BLEED_PX + 1.5
      );
      expect(fit.uniformScale).toBeGreaterThan(0);
      expect(fit.framing).toBe("half");
    }
  });

  it("centers the head horizontally", () => {
    for (const viewport of viewports) {
      const fit = computePortraitHeadFit({
        viewportWidth: viewport.w,
        viewportHeight: viewport.h,
        modelWidth,
        modelHeight
      });
      const rect = projectHeadBoundsToViewportPx(LUMI_PORTRAIT_HEAD_BOUNDS, fit);
      expect(rect.centerX).toBeCloseTo(viewport.w / 2, 1);
    }
  });

  it("places the crown near the top safe margin when height allows", () => {
    // Tall window: width-limited, so crown should sit on the top margin.
    const fit = computePortraitHeadFit({
      viewportWidth: 280,
      viewportHeight: 720,
      modelWidth,
      modelHeight
    });
    const crown = projectModelToViewportPx(
      0,
      LUMI_PORTRAIT_HEAD_BOUNDS.top,
      fit
    );
    expect(crown.y).toBeCloseTo(LUMI_PORTRAIT_MARGINS.top, 0);
  });

  it("is width-limited on narrow-tall windows and covers the transparent viewport", () => {
    const fit = computePortraitHeadFit({
      viewportWidth: 280,
      viewportHeight: 720,
      modelWidth,
      modelHeight
    });
    const headW = LUMI_PORTRAIT_HEAD_BOUNDS.right - LUMI_PORTRAIT_HEAD_BOUNDS.left;
    const expectedTarget = 280 + LUMI_PORTRAIT_MAX_HORIZONTAL_BLEED_PX * 2;
    expect(fit.uniformScale).toBeCloseTo(expectedTarget / headW, 5);
    const rect = projectHeadBoundsToViewportPx(LUMI_PORTRAIT_HEAD_BOUNDS, fit);
    expect(rect.left).toBeCloseTo(-LUMI_PORTRAIT_MAX_HORIZONTAL_BLEED_PX, 1);
    expect(rect.right).toBeCloseTo(280 + LUMI_PORTRAIT_MAX_HORIZONTAL_BLEED_PX, 1);
    expect(isUniformPixelScale(fit)).toBe(true);
  });

  it("is height-limited on wide-short windows and accepts side letterboxing", () => {
    const fit = computePortraitHeadFit({
      viewportWidth: 900,
      viewportHeight: 400,
      modelWidth,
      modelHeight
    });
    const headH = LUMI_PORTRAIT_HEAD_BOUNDS.top - LUMI_PORTRAIT_HEAD_BOUNDS.bottom;
    const availH = 400 - LUMI_PORTRAIT_MARGINS.top - LUMI_PORTRAIT_MARGINS.bottom;
    expect(fit.uniformScale).toBeCloseTo(availH / headH, 5);
    const rect = projectHeadBoundsToViewportPx(LUMI_PORTRAIT_HEAD_BOUNDS, fit);
    // Side letterboxing: head does not need to touch left/right margins.
    expect(rect.left).toBeGreaterThanOrEqual(LUMI_PORTRAIT_MARGINS.horizontal - 1);
    expect(rect.right).toBeLessThanOrEqual(900 - LUMI_PORTRAIT_MARGINS.horizontal + 1);
    expect(isHeadFullyVisible(fit)).toBe(true);
    expect(isUniformPixelScale(fit)).toBe(true);
  });

  it("does not use the body extent when computing portrait scale", () => {
    const fit = computePortraitHeadFit({
      viewportWidth: 480,
      viewportHeight: 720,
      modelWidth,
      modelHeight
    });
    // Full model height is 2; head height is much smaller → portrait scale is
    // larger than a full-body contain of the same viewport.
    const full = computeFullBodyFit({
      viewportWidth: 480,
      viewportHeight: 720,
      modelWidth,
      modelHeight
    });
    expect(fit.uniformScale).toBeGreaterThan(full.uniformScale);
  });

  it("fills the default portrait width more aggressively than strict contain", () => {
    const fit = computePortraitHeadFit({
      viewportWidth: 480,
      viewportHeight: 720,
      modelWidth,
      modelHeight
    });
    const rect = projectHeadBoundsToViewportPx(LUMI_PORTRAIT_HEAD_BOUNDS, fit);
    const strictContainWidth = 480 - LUMI_PORTRAIT_MARGINS.horizontal * 2;
    expect(rect.right - rect.left).toBeGreaterThan(strictContainWidth);
    expect(rect.left).toBeGreaterThanOrEqual(-LUMI_PORTRAIT_MAX_HORIZONTAL_BLEED_PX - 1);
    expect(rect.right).toBeLessThanOrEqual(
      480 + LUMI_PORTRAIT_MAX_HORIZONTAL_BLEED_PX + 1
    );
  });
});

describe("full-body framing", () => {
  it("uses uniform contain and does not share portrait head bounds", () => {
    const full = computeFullBodyFit({
      viewportWidth: 480,
      viewportHeight: 720,
      modelWidth: 2,
      modelHeight: 2
    });
    expect(full.framing).toBe("full");
    expect(isUniformPixelScale(full)).toBe(true);
    // Soft inset keeps the model slightly inside the viewport.
    expect(full.uniformScale).toBeLessThanOrEqual(
      Math.min(480 / 2, 720 / 2) * LUMI_FULL_BODY_FIT + 1e-6
    );
  });

  it("keeps portrait and full-body transforms independent across switches", () => {
    const portrait = computeLumiFramingTransform("half", 480, 720, 2, 2);
    const full = computeLumiFramingTransform("full", 480, 720, 2, 2);
    const portraitAgain = computeLumiFramingTransform("half", 480, 720, 2, 2);
    expect(portrait.uniformScale).not.toBeCloseTo(full.uniformScale, 3);
    expect(portraitAgain.uniformScale).toBeCloseTo(portrait.uniformScale, 6);
    expect(portraitAgain.translateY).toBeCloseTo(portrait.translateY, 6);
  });
});

describe("cache keys and DPR", () => {
  it("treats identical fit keys as equal so matrices are not rewritten every frame", () => {
    const key = {
      framing: "half" as const,
      cssWidth: 480,
      cssHeight: 720,
      modelWidth: 2,
      modelHeight: 2
    };
    expect(sameFitKey(key, key)).toBe(true);
    expect(sameFitKey(key, { ...key, cssWidth: 481 })).toBe(false);
    expect(sameFitKey(key, { ...key, framing: "full" })).toBe(false);
    expect(sameFitKey(null, key)).toBe(false);
  });

  it("keeps DPR out of the model matrix inputs (CSS size only)", () => {
    const css = getLumiRenderMetrics(400, 600, 1.5);
    expect(css.pixelWidth).not.toBe(css.cssWidth);
    const fitCss = computePortraitHeadFit({
      viewportWidth: css.cssWidth,
      viewportHeight: css.cssHeight,
      modelWidth: 2,
      modelHeight: 2
    });
    const fitPixels = computePortraitHeadFit({
      viewportWidth: css.pixelWidth,
      viewportHeight: css.pixelHeight,
      modelWidth: 2,
      modelHeight: 2
    });
    // Callers must pass CSS sizes; pixel sizes would mis-scale margins.
    expect(fitCss.uniformScale).not.toBeCloseTo(fitPixels.uniformScale, 3);
    expect(isUniformPixelScale(fitCss)).toBe(true);
  });

  it("builds diagnostics with matching projected head corners", () => {
    const transform = computePortraitHeadFit({
      viewportWidth: 480,
      viewportHeight: 720,
      modelWidth: 2,
      modelHeight: 2
    });
    const diagnostics = buildFramingDiagnostics(transform, {
      backingWidth: 960,
      backingHeight: 1440,
      devicePixelRatio: 2
    });
    expect(diagnostics.backingWidth).toBe(960);
    expect(diagnostics.pixelsPerUnitX).toBeCloseTo(diagnostics.pixelsPerUnitY, 6);
    expect(diagnostics.headProjectionPx.centerX).toBeCloseTo(240, 1);
  });

  it("keeps legacy zoom helper ordered for tests without driving portrait", () => {
    expect(getLumiFramingZoom("half")).toBeGreaterThan(getLumiFramingZoom("full"));
  });
});

describe("Companion full-body resized product windows", () => {
  it.each([[360, 720], [480, 720], [800, 560], [1000, 600]])("contains and centers without stretching at %sx%s", (width, height) => {
    const fit = computeLumiFramingTransform("full", width, height, 1, 1.66225);
    expect(isUniformPixelScale(fit)).toBe(true);
    expect(fit.viewportWidth).toBe(width);
    expect(fit.viewportHeight).toBe(height);
    expect(fit.translateX).toBe(0);
    expect(fit.translateY).toBe(0);
    expect(fit.uniformScale).toBeLessThanOrEqual(width - 32);
    expect(fit.uniformScale * 1.66225).toBeLessThanOrEqual(height - 32);
  });
});
