import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./tauri-window.js", () => ({
  isTauriRuntime: () => true,
  controlCompanionWindow: vi.fn(),
  getCompanionPresentationState: vi.fn(async () => ({ visible: false }))
}));
vi.mock("./user-settings-client.js", () => ({
  fetchUserSettings: vi.fn(),
  saveUserSettings: vi.fn()
}));

import {
  CompanionAppearanceSettings,
  companionAlwaysOnTopPatch
} from "./companion-appearance-settings.js";

describe("CompanionAppearanceSettings", () => {
  it("writes only the existing companion always-on-top field", () => {
    expect(companionAlwaysOnTopPatch(false)).toEqual({ companion: { alwaysOnTop: false } });
  });

  it("renders the normal desktop window control without runtime fields", () => {
    const markup = renderToStaticMarkup(<CompanionAppearanceSettings />);
    expect(markup).toContain("Companion window");
    expect(markup).toContain("Always on top");
    expect(markup).toContain("Show Companion");
    expect(markup).toContain("Hide Companion");
    expect(markup).toContain("Companion status:");
    expect(markup).toContain("unavailable");
    expect(markup).toContain("Live2D renderer:");
    expect(markup).not.toContain("Companion status: hidden");
    expect(markup).not.toContain("Live2D renderer: failed");
    expect(markup).not.toContain("Lumi");
    expect(markup).not.toContain("Service URL");
    expect(markup).not.toContain("Connection mode");
  });
});
