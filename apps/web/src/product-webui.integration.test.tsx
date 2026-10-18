import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, readText, type FakeNode } from "./test-dom.js";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  reload: vi.fn(),
  health: null as any,
  settings: {} as any
}));
vi.mock("./api/client.js", () => ({
  request: async () => {
    throw new Error("No connection");
  },
  productSample: vi.fn(),
  apiClient: {
    getRuntimeSettings: async () => state.settings,
    getProviderStatus: async () => ({ providers: {}, routes: {} }),
    getEvents: async () => [],
    getHealth: async () => state.health,
    updateRuntimeSettings: state.update,
    reloadRuntimeSettings: state.reload
  }
}));
vi.mock("./App.js", () => ({ App: () => <div>Developer dashboard</div> }));
vi.mock("./tauri-window.js", () => ({ isTauriRuntime: () => true }));
vi.mock("./locale-selector.js", () => ({ LocaleSelector: () => <div>Locale controls</div> }));
vi.mock("./product-live2d-models.js", () => ({
  ProductLive2DModels: () => <div>Live2D controls</div>
}));
vi.mock("./companion-appearance-settings.js", () => ({
  CompanionAppearanceSettings: () => <div>Companion window controls</div>
}));
vi.mock("./subtitle-appearance-settings.js", () => ({
  SubtitleAppearanceSettings: () => <div>Subtitle window controls</div>
}));
vi.mock("./product-first-run-setup.js", () => ({
  ProductFirstRunSetup: ({ onNavigate }: { onNavigate(view: "advanced" | "appearance"): void }) => (
    <div>
      <span>First-run setup controls</span>
      <button type="button" onClick={() => onNavigate("advanced")}>
        Configure Chat
      </button>
      <button type="button" onClick={() => onNavigate("appearance")}>
        Choose Companion model
      </button>
    </div>
  )
}));
vi.mock("./product-memory-settings.js", () => ({
  ProductMemorySettings: () => <div>Memory connection</div>
}));
vi.mock("./product-configuration.js", () => ({
  ProductConfigurationPanel: ({ sections }: { sections?: readonly string[] }) => (
    <div>Configuration sections: {(sections ?? ["all"]).join(",")}</div>
  )
}));
vi.mock("./user-settings-panel.js", () => ({
  UserSettingsPanel: () => <div>Desktop settings</div>
}));

function button(node: FakeNode, label: string): FakeNode | undefined {
  if (node.tagName === "BUTTON" && readText(node) === label) return node;
  for (const child of node.childNodes) {
    const found = button(child, label);
    if (found) return found;
  }
}
function click(node: FakeNode | undefined): void {
  expect(node).toBeDefined();
  const key = Object.keys(node!).find((key) => key.startsWith("__reactProps$"))!;
  const props = (node as unknown as Record<string, { onClick(): void; disabled?: boolean }>)[key]!;
  expect(props.disabled).not.toBe(true);
  props.onClick();
}
let root: Root | undefined;
let dom: ReturnType<typeof installFakeDom> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  dom?.restore();
  vi.clearAllMocks();
  state.health = null;
});
async function mount(element: JSX.Element) {
  dom = installFakeDom();
  await act(async () => {
    root = createRoot(dom!.container as unknown as Element);
    root.render(<StrictMode>{element}</StrictMode>);
  });
  return dom.container;
}
describe("Product WebUI integration", () => {
  it("does not fall back to Legacy Memory when Runtime health is unavailable", async () => {
    state.health = null;
    const { ProductWebUI } = await import("./product-webui.js");
    const node = await mount(<ProductWebUI />);
    await act(async () => click(button(node, "Memory")));
    expect(readText(node)).toContain("Memory 服务状态不可用");
    expect(readText(node)).not.toContain("Desktop settings");
    expect(readText(node)).not.toContain("Memory connection");
  });
  it("separates daily-use concerns while keeping advanced and Developer reachable", async () => {
    const { ProductWebUI } = await import("./product-webui.js");
    const node = await mount(<ProductWebUI />);
    expect(readText(node)).toContain("First-run setup controls");
    expect(readText(node)).not.toContain("Configuration sections:");

    await act(async () => click(button(node, "Configure Chat")));
    expect(readText(node)).toContain("Configuration sections: providers,models,routes");
    expect(readText(node)).not.toContain("Desktop settings");
    await act(async () => click(button(node, "Overview")));
    await act(async () => click(button(node, "Choose Companion model")));
    expect(readText(node)).toContain("Live2D controls");
    expect(readText(node)).toContain("Companion window controls");
    expect(readText(node)).not.toContain("Subtitle window controls");
    await act(async () => click(button(node, "People & voices")));
    expect(readText(node)).toContain("Configuration sections: people,voices");
    await act(async () => click(button(node, "Memory")));
    expect(readText(node)).toContain("Memory 服务状态不可用");
    await act(async () => click(button(node, "Conversation")));
    expect(readText(node)).toContain("Configuration sections: proactive");
    await act(async () => click(button(node, "Subtitle")));
    expect(readText(node)).toContain("Subtitle window controls");
    await act(async () => click(button(node, "System")));
    expect(readText(node)).toContain("Locale controls");
    expect(readText(node)).toContain("Configuration sections: status");
    expect(readText(node)).not.toContain("Desktop settings");
    await act(async () => click(button(node, "Open developer console")));
    expect(readText(node)).toContain("Developer dashboard");
    await act(async () => click(button(node, "← Product WebUI")));
    expect(readText(node)).toContain("Connection troubleshooting");
  });

  it.each([
    ["models", "models"],
    ["routing", "routes"]
  ])("scopes the legacy %s wrapper to one shared configuration section", async (view, expected) => {
    const { ProductModelsProviders } = await import("./product-models-providers.js");
    const { ProductAIRouting } = await import("./product-ai-routing.js");
    const node = await mount(view === "models" ? <ProductModelsProviders /> : <ProductAIRouting />);
    expect(readText(node)).toContain(`Configuration sections: ${expected}`);
    expect(state.update).not.toHaveBeenCalled();
    expect(state.reload).not.toHaveBeenCalled();
  });
});
