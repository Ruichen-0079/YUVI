import { afterEach, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, readText, type FakeNode } from "./test-dom.js";
import { ProductConfigurationPanel, reorderRoute } from "./product-configuration.js";
const mock = vi.hoisted(() => ({ request: vi.fn(), sample: vi.fn() }));
vi.mock("./api/client.js", () => ({ request: mock.request, productSample: mock.sample, apiClient: { setDashboardDevToken: vi.fn() } }));
const caps = ["chat", "reasoning", "proactive", "embedding", "vision", "stt", "tts"];
function snapshot() { return { revision: 0, configuration: { version: 1, providers: [{ id: "p", displayName: "Endpoint", baseUrl: "http://localhost:8000", adapter: "openai-compatible" }], models: [{ id: "a", providerId: "p", displayName: "A", modelId: "a", temperature: .7, contextWindow: null, capabilities: ["chat"], enabled: true }, { id: "b", providerId: "p", displayName: "B", modelId: "b", temperature: .7, contextWindow: null, capabilities: ["chat"], enabled: true }], routes: Object.fromEntries(caps.map(c => [c, []])) }, people: [], primaryPersonId: null, proactive: { threshold: .7, intervalMs: 60000 }, proactiveState: { suppression: { kind: "NONE" }, eligibleAfterMs: 0 }, conversationalReady: false, applyState: "ACTIVE", routes: Object.fromEntries(caps.map(c => [c, { state: "NOT_CONFIGURED", modelIds: [] }])) }; }
function nodes(node: FakeNode): FakeNode[] { return [node, ...node.childNodes.flatMap(nodes)]; }
function props(node: FakeNode): any { return (node as any)[Object.keys(node).find(k => k.startsWith("__reactProps$"))!]; }
let root: Root | undefined, dom: ReturnType<typeof installFakeDom> | undefined;
afterEach(async () => { await act(async () => root?.unmount()); dom?.restore(); vi.clearAllMocks(); });
async function mount(sections?: readonly ("status" | "providers" | "models" | "routes" | "proactive" | "people" | "voices")[]) { dom = installFakeDom(); await act(async () => { root = createRoot(dom!.container as unknown as Element); root.render(<StrictMode><ProductConfigurationPanel {...(sections ? { sections } : {})} /></StrictMode>); }); return dom.container; }
it("first-run controls work with no Chat; compatible route assignment saves then re-fetches effective state", async () => {
  let saved = snapshot();
  mock.request.mockImplementation(async (url, init) => {
    if (url === "/product/voices") return { available: false, voices: [], unknown: [] };
    if (init?.method === "PUT") { const body = JSON.parse(init.body); saved = { ...saved, configuration: body.configuration, revision: saved.revision + 1, applyState: "RESTART_REQUIRED" }; }
    return structuredClone(saved);
  });
  const node = await mount(); expect(readText(node)).toContain("set up Chat"); expect(readText(node)).toContain("My profile");
  const route = nodes(node).find(n => n.attributes["aria-label"] === "Chat route")!;
  const select = nodes(route).find(n => n.tagName === "SELECT")!;
  await act(async () => props(select).onChange({ target: { value: "a" } }));
  const button = nodes(node).find(n => n.tagName === "BUTTON" && readText(n) === "Save routes & apply")!;
  await act(async () => props(button).onClick());
  const update = mock.request.mock.calls.find(c => c[1]?.method === "PUT"); expect(JSON.parse(update![1].body).configuration.routes.chat).toEqual(["a"]);
  expect(mock.request.mock.calls.filter(c => c[0] === "/product/configuration" && !c[1]?.method).length).toBeGreaterThan(1);
  expect(readText(node)).toContain("RESTART_REQUIRED"); expect(readText(node)).toContain("Effective: None"); expect(props(button).disabled).toBe(false);
  const stt = nodes(node).find(n => n.attributes["aria-label"] === "Speech recognition route")!; expect(nodes(stt).filter(n => n.tagName === "OPTION").map(readText)).toEqual(["Select model"]);
});
it("sectioned presentation hides unrelated controls and loads voice state only when it becomes visible", async () => {
  mock.request.mockImplementation(async url => url === "/product/voices"
    ? { available: false, voices: [], unknown: [] }
    : snapshot());
  const node = await mount(["models"]);
  const text = readText(node);
  expect(text).toContain("Models");
  expect(text).not.toContain("Providers");
  expect(text).not.toContain("Capability routes");
  expect(text).not.toContain("My profile");
  expect(text).not.toContain("Voice enrollment");
  expect(mock.request.mock.calls.some(c => c[0] === "/product/voices")).toBe(false);

  await act(async () => {
    root!.render(<StrictMode><ProductConfigurationPanel sections={["people", "voices"]} /></StrictMode>);
  });
  expect(mock.request.mock.calls.some(c => c[0] === "/product/voices")).toBe(true);
  expect(readText(node)).toContain("Voice enrollment");
});
it("fallback order edits are stable and bounded", () => { expect(reorderRoute(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]); expect(reorderRoute(["a"], 0, -1)).toEqual(["a"]); });
it("people surface hides raw identity fields and saves the primary profile without a persona writer", async () => {
  const saved = {
    ...snapshot(),
    people: [
      { id: "me", displayName: "Rui", personaId: "alice", notes: "My profile" },
      { id: "friend", displayName: "Ming", personaId: "alice", notes: "Roommate" }
    ],
    primaryPersonId: "me"
  };
  mock.request.mockImplementation(async (url, init) => {
    if (url === "/product/voices") {
      return {
        available: true,
        voices: [{ id: "voice-me", label: "Rui", personId: "me", sampleId: "sample-me" }],
        unknown: []
      };
    }
    if (url === "/product/people" && init?.method === "POST") {
      return {
        ...saved,
        personId: "me",
        profileEvidence: {
          classification: "NON_EVIDENCE",
          projectionVersion: "product-person-profile.v1",
          owner: "PRODUCT_PERSON_STORE",
          personId: "me",
          personRevision: null,
          lineageStatus: "LEGACY_UNLINEAGED"
        },
        message: "saved"
      };
    }
    return structuredClone(saved);
  });
  const node = await mount(["people", "voices"]);
  const text = readText(node);
  for (const visible of ["My profile", "People I know", "Ming", "Voice enrollment", "Re-enroll"]) expect(text).toContain(visible);
  expect(nodes(node).filter(n => n.tagName === "INPUT").map(n => props(n).value)).toContain("Rui");
  for (const hidden of ["Current Yuvi persona", "Stable user ID", "This is my primary profile", "personaId"]) expect(text).not.toContain(hidden);
  const profileForm = nodes(node).find(n => n.tagName === "FORM" && readText(n).includes("Save my profile"))!;
  await act(async () => {
    props(profileForm).onSubmit({ preventDefault: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
  });
  const call = mock.request.mock.calls.find(c => c[0] === "/product/people" && c[1]?.method === "POST");
  const body = JSON.parse(call![1].body);
  expect(body).toMatchObject({
    id: "me",
    displayName: "Rui",
    notes: "My profile",
    primary: true,
    expectedPersonRevision: null,
    expectedPrimaryRevision: null
  });
  expect(body.commandHandle).toMatch(/^[a-f0-9-]{36}$/);
  expect(body).not.toHaveProperty("personaId");
  expect(readText(node)).toContain(
    "Person profile saved in Product settings; no Memory evidence was created."
  );
});

it("unrecognized voice review stays explicit and local without exposing acoustic internals", async () => {
  const saved = { ...snapshot(), people: [{ id: "me", displayName: "Rui", personaId: "alice", notes: "" }], primaryPersonId: "me" };
  mock.request.mockImplementation(async url => url === "/product/voices"
    ? { available: true, voices: [], unknown: [{ id: "review" }] }
    : saved);
  const node = await mount(["people", "voices"]);
  for (const text of ["Unrecognized voices", "Play sample", "Assign to person", "Add person", "Keep unrecognized", "Delete sample"]) expect(readText(node)).toContain(text);
  await act(async () => props(nodes(node).find(n => n.tagName === "BUTTON" && readText(n) === "Keep unrecognized")!).onClick());
  expect(mock.request).toHaveBeenCalledWith("/product/voice-samples/review/review", expect.objectContaining({ body: JSON.stringify({ leaveUnknown: true }) }));
  expect(readText(node)).not.toMatch(/similarity|cluster ID|embedding vector|voiceProfileId/);
});

it("keeps unsaved route choices while navigating the AI setup steps", async () => {
  mock.request.mockResolvedValue(snapshot());
  const node = await mount(["providers", "models", "routes"]);
  const clickNamed = async (label: string) =>
    act(async () =>
      props(nodes(node).find((n) => n.tagName === "BUTTON" && readText(n) === label)!).onClick()
    );
  expect(readText(node)).not.toContain("Add compatible model");
  await clickNamed("3. Model assignments");
  const route = nodes(node).find((n) => n.attributes["aria-label"] === "Chat route")!;
  await act(async () =>
    props(nodes(route).find((n) => n.tagName === "SELECT")!).onChange({ target: { value: "a" } })
  );
  await clickNamed("1. Providers");
  await clickNamed("3. Model assignments");
  await clickNamed("Save routes & apply");
  const update = mock.request.mock.calls.find((c) => c[1]?.method === "PUT");
  expect(JSON.parse(update![1].body).configuration.routes.chat).toEqual(["a"]);
});

it("finishes failed loading and allows retry without leaving a blank settings page", async () => {
  mock.request.mockRejectedValue(new Error("offline"));
  const node = await mount(["models"]);
  expect(readText(node)).toContain("Could not load settings");
  expect(readText(node)).not.toContain("Loading configuration…");
  mock.request.mockResolvedValue(snapshot());
  await act(async () =>
    props(nodes(node).find((n) => n.tagName === "BUTTON" && readText(n) === "Retry")!).onClick()
  );
  expect(readText(node)).toContain("Save model & apply");
  expect(readText(node)).not.toContain("Could not load settings");
});

it("a stalled provider test leaves writes usable, preserves the draft, and does not reload it", async () => {
  let finish!: (value: unknown) => void;
  mock.request.mockImplementation((url) => url.endsWith("/test")
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve(snapshot()));
  const node = await mount(["providers", "routes"]);
  const route = nodes(node).find(n => n.attributes["aria-label"] === "Chat route")!;
  const select = nodes(route).find(n => n.tagName === "SELECT")!;
  await act(async () => props(select).onChange({ target: { value: "a" } }));
  const test = nodes(node).find(n => n.tagName === "BUTTON" && readText(n) === "Test connection / discover models")!;
  const save = nodes(node).find(n => n.tagName === "BUTTON" && readText(n) === "Save routes & apply")!;
  await act(async () => { props(test).onClick(); });
  expect(props(test).disabled).toBe(true);
  expect(props(save).disabled).toBe(false);
  const reads = mock.request.mock.calls.filter(c => c[0] === "/product/configuration").length;
  await act(async () => finish({ message: "Connection test failed.", models: [] }));
  expect(props(test).disabled).toBe(false);
  expect(mock.request.mock.calls.filter(c => c[0] === "/product/configuration")).toHaveLength(reads);
  await act(async () => props(save).onClick());
  const write = mock.request.mock.calls.find(c => c[1]?.method === "PUT")!;
  expect(JSON.parse(write[1].body).configuration.routes.chat).toEqual(["a"]);
  expect(readText(node)).toContain("Connection test failed.");
});

it("a stalled optional voice refresh does not hold the configuration write lock", async () => {
  mock.request.mockImplementation((url) => url === "/product/voices" ? new Promise(() => {}) : Promise.resolve(snapshot()));
  const node = await mount();
  const save = nodes(node).find(n => n.tagName === "BUTTON" && readText(n) === "Save routes & apply")!;
  await act(async () => props(save).onClick());
  expect(props(save).disabled).toBe(false);
  expect(readText(node)).toContain("Saved. Effective state refreshed.");
});

it("a failed provider test recovers independently of a pending save and its error stays visible", async () => {
  let finishSave!: (value: unknown) => void;
  mock.request.mockImplementation((url, init) => {
    if (url.endsWith("/test")) return Promise.reject(new Error("Provider request timed out"));
    if (init?.method === "PUT") return new Promise(resolve => { finishSave = resolve; });
    return Promise.resolve(snapshot());
  });
  const node = await mount(["providers", "routes"]);
  const save = nodes(node).find(n => n.tagName === "BUTTON" && readText(n) === "Save routes & apply")!;
  const test = nodes(node).find(n => n.tagName === "BUTTON" && readText(n) === "Test connection / discover models")!;
  await act(async () => { props(save).onClick(); });
  expect(props(save).disabled).toBe(true);
  expect(props(test).disabled).toBe(false);
  await act(async () => props(test).onClick());
  expect(props(test).disabled).toBe(false);
  expect(props(save).disabled).toBe(true);
  await act(async () => finishSave(snapshot()));
  expect(props(save).disabled).toBe(false);
  expect(readText(node)).toContain("Provider request timed out");
});
