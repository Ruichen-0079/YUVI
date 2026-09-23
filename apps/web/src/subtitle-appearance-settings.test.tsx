import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./tauri-window.js", () => ({
  isTauriRuntime: () => true,
  controlSubtitleWindow: vi.fn(),
  getSubtitlePresentationState: vi.fn(async () => ({ visible: false, locked: false })),
  setSubtitleLocked: vi.fn(async (locked: boolean) => ({ visible: false, locked }))
}));

import { SubtitleAppearanceSettings } from "./subtitle-appearance-settings.js";

describe("SubtitleAppearanceSettings", () => {
  it("renders external show/hide/lock controls without subtitle content authority", () => {
    const markup = renderToStaticMarkup(<SubtitleAppearanceSettings />);
    expect(markup).toContain("Subtitle window");
    expect(markup).toContain("Show subtitle");
    expect(markup).toContain("Hide subtitle");
    expect(markup).toContain("Lock &amp; click through");
    expect(markup).toContain("Subtitle status: unavailable");
    expect(markup).not.toContain("Subtitle status: hidden · unlocked");
    expect(markup).not.toContain('aria-pressed="false"');
    expect(markup).not.toContain("Output language");
    expect(markup).not.toContain("Memory");
    expect(markup).not.toContain("TTS");
  });
});
