import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProductConfiguration } from "@companion/providers";
import {
  applyProductPersonCommand,
  commitProductSettings,
  defaultProductSettings,
  fenceProductPersonCommand,
  productEnvironment,
  productPath,
  readProductSettings,
  reconcileProductPersonCommand,
  type ProductPersonCommandPayload,
  type ProductSettings,
  writePrivateJson,
  writeProductSettings
} from "./product-store.js";

const MANAGED_ENV = {
  YUVI_PORTABLE_VERSION: "0.1.2",
  LOCAL_STT_BASE_URL: "http://127.0.0.1:19876",
  LOCAL_TTS_BASE_URL: "http://127.0.0.1:19881",
  GPT_SOVITS_TTS_BASE_URL: "http://127.0.0.1:19881",
  GPT_SOVITS_TTS_UPSTREAM_URL: "http://127.0.0.1:19880"
} as Record<string, string | undefined>;

function settingsWith(
  providers: ProductSettings["configuration"]["providers"],
  models: ProductSettings["configuration"]["models"],
  routes: Partial<ProductSettings["configuration"]["routes"]>
): ProductSettings {
  return {
    configuration: {
      version: 1,
      providers,
      models,
      routes: { chat: [], reasoning: [], proactive: [], embedding: [], vision: [], stt: [], tts: [], ...routes }
    },
    people: [],
    primaryPersonId: null,
    proactive: { threshold: 0.7, intervalMs: 60000 },
    revision: 1
  };
}

const sttProvider = (baseUrl: string) => ({ id: "stt-p", displayName: "Local STT", baseUrl, adapter: "local-stt" as const });
const sttModel = (providerId: string) => ({ id: "stt-m", providerId, displayName: "sensevoice", modelId: "sensevoice", temperature: 0.7, contextWindow: null, capabilities: ["stt" as const], enabled: true });
const ttsProvider = (baseUrl: string) => ({ id: "tts-p", displayName: "Local TTS", baseUrl, adapter: "dots-tts" as const });
const ttsModel = (providerId: string) => ({ id: "tts-m", providerId, displayName: "dots-studio/dots.tts-soar", modelId: "dots-studio/dots.tts-soar", temperature: 0.7, contextWindow: null, capabilities: ["tts" as const], enabled: true });

describe("portable provider routing (routing is not ownership)", () => {
  it("keeps managed defaults untouched when no explicit local route is selected", () => {
    const out = productEnvironment({ ...MANAGED_ENV }, settingsWith([], [], {}));
    expect(out["LOCAL_STT_BASE_URL"]).toBe("http://127.0.0.1:19876");
    expect(out["LOCAL_TTS_BASE_URL"]).toBe("http://127.0.0.1:19881");
    expect(out["GPT_SOVITS_TTS_UPSTREAM_URL"]).toBe("http://127.0.0.1:19880");
    expect(out["YUVI_PRODUCT_CONFIGURATION"]).toBeDefined();
  });

  it("allows an explicit external localhost STT endpoint without rewriting managed env", () => {
    const out = productEnvironment(
      { ...MANAGED_ENV },
      settingsWith([sttProvider("http://127.0.0.1:9876")], [sttModel("stt-p")], { stt: ["stt-m"] })
    );
    expect(out["LOCAL_STT_BASE_URL"]).toBe("http://127.0.0.1:19876");
    const adopted = parseProductConfiguration(JSON.parse(out["YUVI_PRODUCT_CONFIGURATION"]!));
    expect(adopted.routes.stt).toEqual(["stt-m"]);
    expect(adopted.providers.find((p) => p.id === "stt-p")?.baseUrl).toBe("http://127.0.0.1:9876");
  });

  it("allows an explicit external localhost TTS endpoint", () => {
    const out = productEnvironment(
      { ...MANAGED_ENV },
      settingsWith([ttsProvider("http://127.0.0.1:9881")], [ttsModel("tts-p")], { tts: ["tts-m"] })
    );
    expect(out["LOCAL_TTS_BASE_URL"]).toBe("http://127.0.0.1:19881");
    const adopted = parseProductConfiguration(JSON.parse(out["YUVI_PRODUCT_CONFIGURATION"]!));
    expect(adopted.routes.tts).toEqual(["tts-m"]);
    expect(adopted.providers.find((p) => p.id === "tts-p")?.baseUrl).toBe("http://127.0.0.1:9881");
  });

  it("keeps managed selections working when explicitly selected", () => {
    const out = productEnvironment(
      { ...MANAGED_ENV },
      settingsWith(
        [sttProvider("http://127.0.0.1:19876"), { id: "tts-g", displayName: "Managed TTS", baseUrl: "http://127.0.0.1:19881", adapter: "gpt-sovits" as const }],
        [sttModel("stt-p"), { id: "tts-m", providerId: "tts-g", displayName: "gpt-sovits", modelId: "alice", temperature: 0.7, contextWindow: null, capabilities: ["tts" as const], enabled: true }],
        { stt: ["stt-m"], tts: ["tts-m"] }
      )
    );
    const adopted = parseProductConfiguration(JSON.parse(out["YUVI_PRODUCT_CONFIGURATION"]!));
    expect(adopted.routes.stt).toEqual(["stt-m"]);
    expect(adopted.routes.tts).toEqual(["tts-m"]);
  });

  it("keeps localhost embedding with its configured dimensions", () => {
    const out = productEnvironment(
      { ...MANAGED_ENV },
      settingsWith(
        [{ id: "emb-p", displayName: "Local embedding", baseUrl: "http://127.0.0.1:8128/v1", adapter: "openai-compatible" as const, apiKey: "k" }],
        [{ id: "emb-m", providerId: "emb-p", displayName: "Qwen3", modelId: "Qwen3-Embedding-0.6B-Q8_0.gguf", temperature: 0.7, contextWindow: null, capabilities: ["embedding" as const], enabled: true, dimensions: 1024 }],
        { embedding: ["emb-m"] }
      )
    );
    const adopted = parseProductConfiguration(JSON.parse(out["YUVI_PRODUCT_CONFIGURATION"]!));
    expect(adopted.providers.find((p) => p.id === "emb-p")?.baseUrl).toBe("http://127.0.0.1:8128/v1");
    expect(adopted.models.find((m) => m.id === "emb-m")?.dimensions).toBe(1024);
  });

  it("leaves installed (non-portable) behavior unchanged", () => {
    const installed = { LOCAL_STT_BASE_URL: "http://127.0.0.1:9876" } as Record<string, string | undefined>;
    const out = productEnvironment(
      installed,
      settingsWith([sttProvider("http://127.0.0.1:9876")], [sttModel("stt-p")], { stt: ["stt-m"] })
    );
    expect(out["LOCAL_STT_BASE_URL"]).toBe("http://127.0.0.1:9876");
    expect(out["YUVI_PORTABLE_VERSION"]).toBeUndefined();
  });

  it("returns env untouched when no settings are saved", () => {
    expect(productEnvironment({ ...MANAGED_ENV }, null)).toEqual({ ...MANAGED_ENV });
  });
});

describe("Product owner generation integrity", () => {
  it("detects edits after a checksummed generation without inventing legacy revisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuvi-product-generation-"));
    const previousDir = process.env["YUVI_RUNTIME_ENV_DIR"];
    process.env["YUVI_RUNTIME_ENV_DIR"] = dir;
    try {
      const original = {
        ...defaultProductSettings(),
        people: [{ id: "person-integrity", displayName: "Rui", personaId: "alice", notes: "" }]
      };
      const legacy = original;
      writePrivateJson(productPath(), legacy);
      expect(readProductSettings()?.personRevisionById?.["person-integrity"]).toBeUndefined();

      const written = writeProductSettings(legacy);
      expect(written.productOwnerEnvelope?.version).toBe(1);
      expect(readProductSettings()?.productOwnerEnvelope?.generation).toBe(written.productOwnerEnvelope?.generation);

      const path = productPath();
      const persisted = JSON.parse(await readFile(path, "utf8")) as ProductSettings;
      persisted.people[0]!.displayName = "External edit";
      await writeFile(path, JSON.stringify(persisted));
      expect(() => readProductSettings()).toThrow("Product settings could not be read.");
    } finally {
      if (previousDir === undefined) delete process.env["YUVI_RUNTIME_ENV_DIR"];
      else process.env["YUVI_RUNTIME_ENV_DIR"] = previousDir;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Product native revisions", () => {
  const person = { id: "person-a", displayName: "A", personaId: "alice", notes: "first" };

  it("versions authored Person fields and primary selection independently from global settings", () => {
    const initial: ProductSettings = {
      configuration: { version: 1, providers: [], models: [], routes: { chat: [], reasoning: [], proactive: [], embedding: [], vision: [], stt: [], tts: [] } },
      people: [person],
      primaryPersonId: "person-a",
      proactive: { threshold: 0.7, intervalMs: 60000 },
      revision: 0
    };
    const created = commitProductSettings(initial, null);
    const personRevision = created.personRevisionById?.[person.id];
    const primaryRevision = created.primaryPersonRevision;
    expect(personRevision).toMatch(/^[a-f0-9-]{36}$/);
    expect(primaryRevision).toMatch(/^[a-f0-9-]{36}$/);

    const configurationChanged = commitProductSettings(
      { ...created, proactive: { threshold: 0.8, intervalMs: 60000 } },
      created
    );
    expect(configurationChanged.revision).toBe(created.revision + 1);
    expect(configurationChanged.personRevisionById?.[person.id]).toBe(personRevision);
    expect(configurationChanged.primaryPersonRevision).toBe(primaryRevision);

    const personChanged = commitProductSettings(
      { ...configurationChanged, people: [{ ...person, notes: "second" }] },
      configurationChanged
    );
    expect(personChanged.personRevisionById?.[person.id]).not.toBe(personRevision);
    expect(personChanged.primaryPersonRevision).toBe(primaryRevision);
  });

  it("does not invent revision lineage for an unchanged legacy Person", () => {
    const legacy: ProductSettings = {
      configuration: { version: 1, providers: [], models: [], routes: { chat: [], reasoning: [], proactive: [], embedding: [], vision: [], stt: [], tts: [] } },
      people: [person],
      primaryPersonId: "person-a",
      proactive: { threshold: 0.7, intervalMs: 60000 },
      revision: 4
    };
    const next = commitProductSettings(legacy, legacy);
    expect(next.personRevisionById).toEqual({});
    expect(next.primaryPersonRevision).toBeNull();
  });

  it("commits a command once and reconciles the owner receipt under a later recovery fence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuvi-product-owner-"));
    const previousDir = process.env["YUVI_RUNTIME_ENV_DIR"];
    process.env["YUVI_RUNTIME_ENV_DIR"] = dir;
    try {
      const payload: ProductPersonCommandPayload = {
        commandHandle: "create-once",
        operation: "CREATE",
        personId: "person-command-once",
        displayName: "Rui",
        personaId: "alice",
        notes: "private notes",
        requestedPrimary: true,
        expectedPersonRevision: null,
        expectedPrimaryRevision: null,
        payloadDigest: "a".repeat(64),
        intentId: "intent-command-once",
        attemptId: "attempt-first",
        fence: "1",
        causalRefs: [{ kind: "JOURNAL_EVENT", namespace: "journal:test", eventId: `jev1_${"a".repeat(16)}` }]
      };
      expect(await fenceProductPersonCommand(payload)).toBe("READY");
      const applied = await applyProductPersonCommand(payload);
      expect(applied.status).toBe("APPLIED");
      if (applied.status !== "APPLIED") throw new Error("Expected native owner commit.");
      expect(readProductSettings()?.people).toHaveLength(1);

      const retry = await reconcileProductPersonCommand({ payload, attemptId: "attempt-first", fence: "2" });
      expect(retry.status).toBe("ALREADY_APPLIED");
      const repeated = await applyProductPersonCommand({ ...payload, fence: "2" });
      expect(repeated.status).toBe("ALREADY_APPLIED");
      expect(readProductSettings()?.people).toHaveLength(1);
      expect(readProductSettings()?.personRevisionById?.[payload.personId]).toBe(applied.receipt.resultingPersonRevision);
    } finally {
      if (previousDir === undefined) delete process.env["YUVI_RUNTIME_ENV_DIR"];
      else process.env["YUVI_RUNTIME_ENV_DIR"] = previousDir;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("proves absence only at the exact predecessor and leaves incompatible newer owner state untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuvi-product-owner-"));
    const previousDir = process.env["YUVI_RUNTIME_ENV_DIR"];
    process.env["YUVI_RUNTIME_ENV_DIR"] = dir;
    try {
      const first = commitProductSettings({
        ...defaultProductSettings(),
        people: [person],
        primaryPersonId: person.id
      }, null);
      writePrivateJson(productPath(), first);
      const payload: ProductPersonCommandPayload = {
        commandHandle: "update-after-newer-state",
        operation: "UPDATE",
        personId: person.id,
        displayName: "Rui requested",
        personaId: "alice",
        notes: "requested",
        requestedPrimary: true,
        expectedPersonRevision: first.personRevisionById?.[person.id] ?? null,
        expectedPrimaryRevision: first.primaryPersonRevision ?? null,
        payloadDigest: "b".repeat(64),
        intentId: "intent-update-newer",
        attemptId: "attempt-first",
        fence: "1",
        causalRefs: [{ kind: "JOURNAL_EVENT", namespace: "journal:test", eventId: `jev1_${"b".repeat(16)}` }]
      };
      expect(await fenceProductPersonCommand(payload)).toBe("READY");
      expect((await reconcileProductPersonCommand({ payload, attemptId: "attempt-first", fence: "1" })).status)
        .toBe("PROVEN_NOT_APPLIED");

      const newer = commitProductSettings({ ...first, people: [{ ...person, notes: "newer state" }] }, first);
      writePrivateJson(productPath(), newer);
      const recovered = await reconcileProductPersonCommand({ payload, attemptId: "attempt-first", fence: "2" });
      expect(recovered.status).toBe("UNKNOWN");
      const staleApply = await applyProductPersonCommand({ ...payload, fence: "2" });
      expect(staleApply).toMatchObject({ status: "CONFLICT" });
      expect(readProductSettings()?.people[0]?.notes).toBe("newer state");
    } finally {
      if (previousDir === undefined) delete process.env["YUVI_RUNTIME_ENV_DIR"];
      else process.env["YUVI_RUNTIME_ENV_DIR"] = previousDir;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
