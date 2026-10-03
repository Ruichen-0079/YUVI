import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { JournalEventRef } from "@companion/protocol";
import { getRuntimeEnvDir } from "../env.js";
import { emptyProductConfiguration, parseProductConfiguration, type ProductConfiguration } from "@companion/providers";
export type Person = { id: string; displayName: string; personaId: string; notes: string };
export type ProductSettings = {
  configuration: ProductConfiguration;
  people: Person[];
  primaryPersonId: string | null;
  proactive: { threshold: number; intervalMs: number };
  /** Global configuration ordering; it is never a Person or primary-selection revision. */
  revision: number;
  /** Missing entries on old files mean LEGACY_UNLINEAGED, not a reconstructed revision. */
  personRevisionById?: Record<string, string>;
  primaryPersonRevision?: string | null;
  productCommandReceipts?: ProductPersonCommandReceipt[];
  productCommandFences?: Record<string, ProductPersonCommandFence>;
  /** In-file integrity envelope; absence identifies a legacy generation. */
  productOwnerEnvelope?: Readonly<{ version: 1; generation: string; digest: string }>;
};
export type ProductPersonCommandReceipt = Readonly<{
  version: "product-person-command-application.v1";
  commandHandle: string;
  intentId: string;
  attemptId: string;
  fence: string;
  payloadDigest: string;
  causalRefs: readonly JournalEventRef[];
  personId: string;
  priorPersonRevision: string | null;
  resultingPersonRevision: string;
  priorPrimaryRevision: string | null;
  resultingPrimaryRevision: string | null;
}>;
export type ProductPersonCommandFence = Readonly<{
  intentId: string;
  attemptId: string;
  fence: string;
  payloadDigest: string;
}>;

let productOwnerQueue: Promise<unknown> = Promise.resolve();
export function withProductSettingsOwner<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = productOwnerQueue.then(operation);
  productOwnerQueue = result.then(() => undefined, () => undefined);
  return result;
}
export function productPath(env = process.env) { return join(getRuntimeEnvDir(env), "product-settings.json"); }
export function readProductSettings(env = process.env): ProductSettings | null {
  try {
    const value = JSON.parse(readFileSync(productPath(env), "utf8")) as ProductSettings;
    parseProductConfiguration(value.configuration);
    if (value.productOwnerEnvelope !== undefined) {
      const envelope = value.productOwnerEnvelope;
      if (!envelope || envelope.version !== 1 ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(envelope.generation) ||
          !/^[a-f0-9]{64}$/.test(envelope.digest) || productSettingsDigest(value, envelope.generation) !== envelope.digest)
        throw new Error("Product settings generation integrity check failed.");
    }
    if (value.personRevisionById !== undefined && (
      !value.personRevisionById || typeof value.personRevisionById !== "object" ||
      Array.isArray(value.personRevisionById) || Object.entries(value.personRevisionById).some(
        ([personId, revision]) => !personId || typeof revision !== "string" || !revision.trim()
      )
    )) throw new Error("Invalid Product Person revision envelope.");
    if (value.primaryPersonRevision !== undefined &&
      value.primaryPersonRevision !== null &&
      (typeof value.primaryPersonRevision !== "string" || !value.primaryPersonRevision.trim())
    ) throw new Error("Invalid Product primary selection revision.");
    if (value.productCommandReceipts !== undefined && (
      !Array.isArray(value.productCommandReceipts) || value.productCommandReceipts.some((receipt) =>
        !receipt || receipt.version !== "product-person-command-application.v1" ||
        typeof receipt.commandHandle !== "string" || !receipt.commandHandle ||
        typeof receipt.intentId !== "string" || !receipt.intentId ||
        typeof receipt.attemptId !== "string" || !receipt.attemptId ||
        typeof receipt.fence !== "string" || !/^[1-9][0-9]*$/.test(receipt.fence) ||
        typeof receipt.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.payloadDigest) ||
        typeof receipt.personId !== "string" || !receipt.personId ||
        typeof receipt.resultingPersonRevision !== "string" || !receipt.resultingPersonRevision ||
        !Array.isArray(receipt.causalRefs)
      )
    )) throw new Error("Invalid Product native command receipt envelope.");
    if (value.productCommandFences !== undefined && (
      !value.productCommandFences || typeof value.productCommandFences !== "object" ||
      Array.isArray(value.productCommandFences) || Object.entries(value.productCommandFences).some(
        ([handle, fence]) => !handle || !fence || typeof fence.intentId !== "string" ||
          typeof fence.attemptId !== "string" || typeof fence.fence !== "string" ||
          !/^[1-9][0-9]*$/.test(fence.fence) || typeof fence.payloadDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(fence.payloadDigest)
      )
    )) throw new Error("Invalid Product command fence envelope.");
    return value;
  }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Product settings could not be read. Restore the local settings file."); }
}
export function writePrivateJson(path: string, value: unknown) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const directoryFd = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}
/** Product settings remain the only authored Person authority; the same file generation detects external edits. */
export function writeProductSettings(saved: ProductSettings, env = process.env): ProductSettings {
  const { productOwnerEnvelope: _oldEnvelope, ...body } = saved;
  const generation = randomUUID();
  const value: ProductSettings = {
    ...body,
    productOwnerEnvelope: { version: 1, generation, digest: productSettingsDigest(body, generation) }
  };
  writePrivateJson(productPath(env), value);
  return value;
}

function productSettingsDigest(settings: Omit<ProductSettings, "productOwnerEnvelope"> | ProductSettings, generation: string): string {
  const { productOwnerEnvelope: _envelope, ...body } = settings as ProductSettings;
  const canonical = canonicalJson({ version: 1, generation, settings: body });
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function samePerson(left: Person | undefined, right: Person | undefined): boolean {
  return left?.id === right?.id && left?.displayName === right?.displayName &&
    left?.personaId === right?.personaId && left?.notes === right?.notes;
}
/** Commit Product owner revisions in the same private file generation as authored state. */
export function commitProductSettings(saved: ProductSettings, previous: ProductSettings | null): ProductSettings {
  const before = previous ?? defaultProductSettings();
  const oldRevisions = before.personRevisionById ?? {};
  const revisions: Record<string, string> = {};
  for (const person of saved.people) {
    const old = before.people.find((entry) => entry.id === person.id);
    const revision = samePerson(old, person) ? oldRevisions[person.id] : randomUUID();
    if (revision) revisions[person.id] = revision;
  }
  const primaryPersonRevision = before.primaryPersonId === saved.primaryPersonId
    ? (before.primaryPersonRevision ?? null)
    : randomUUID();
  return {
    ...saved,
    revision: before.revision + 1,
    personRevisionById: revisions,
    primaryPersonRevision,
    ...(previous?.productCommandReceipts ? { productCommandReceipts: previous.productCommandReceipts } : {}),
    ...(previous?.productCommandFences ? { productCommandFences: previous.productCommandFences } : {})
  };
}

export type ProductPersonCommandPayload = Readonly<{
  commandHandle: string;
  operation: "CREATE" | "UPDATE";
  personId: string;
  displayName: string;
  personaId: string;
  notes: string;
  requestedPrimary: boolean;
  expectedPersonRevision: string | null;
  expectedPrimaryRevision: string | null;
  payloadDigest: string;
  intentId: string;
  attemptId: string;
  fence: string;
  causalRefs: readonly JournalEventRef[];
}>;
export type ProductPersonCommandApplyResult =
  | { status: "APPLIED" | "ALREADY_APPLIED"; settings: ProductSettings; receipt: ProductPersonCommandReceipt }
  | { status: "PROVEN_NOT_APPLIED"; reason: "NO_COMMAND_RECEIPT_AFTER_FENCE" }
  | { status: "UNKNOWN" | "CONFLICT" };

export async function fenceProductPersonCommand(input: {
  commandHandle: string;
  intentId: string;
  attemptId: string;
  fence: string;
  payloadDigest: string;
}): Promise<"READY" | "CONFLICT"> {
  return withProductSettingsOwner(() => {
    const settings = readProductSettings() ?? defaultProductSettings();
    const receipts = settings.productCommandReceipts ?? [];
    const receipt = receipts.find((item) => item.commandHandle === input.commandHandle);
    if (receipt) return receipt.payloadDigest === input.payloadDigest &&
      receipt.intentId === input.intentId && receipt.attemptId === input.attemptId &&
      BigInt(receipt.fence) <= BigInt(input.fence) ? "READY" : "CONFLICT";
    const prior = settings.productCommandFences?.[input.commandHandle];
    if (prior && prior.payloadDigest !== input.payloadDigest) return "CONFLICT";
    if (prior && prior.intentId === input.intentId && BigInt(prior.fence) >= BigInt(input.fence)) {
      return prior.attemptId === input.attemptId && prior.fence === input.fence ? "READY" : "CONFLICT";
    }
    const next: ProductSettings = {
      ...settings,
      productCommandFences: {
        ...(settings.productCommandFences ?? {}),
        [input.commandHandle]: Object.freeze({
          intentId: input.intentId,
          attemptId: input.attemptId,
          fence: input.fence,
          payloadDigest: input.payloadDigest
        })
      }
    };
    writeProductSettings(next);
    return "READY";
  });
}

/** Product is the sole Person owner; state and the exact A9 application receipt share one fsynced generation. */
export async function applyProductPersonCommand(
  payload: ProductPersonCommandPayload
): Promise<ProductPersonCommandApplyResult> {
  return withProductSettingsOwner(() => {
    const previous = readProductSettings() ?? defaultProductSettings();
    const existingReceipt = previous.productCommandReceipts?.find(
      (receipt) => receipt.commandHandle === payload.commandHandle
    );
    if (existingReceipt) {
      if (
        existingReceipt.payloadDigest !== payload.payloadDigest ||
        existingReceipt.intentId !== payload.intentId ||
        existingReceipt.attemptId !== payload.attemptId ||
        BigInt(existingReceipt.fence) > BigInt(payload.fence)
      ) return { status: "CONFLICT" as const };
      return { status: "ALREADY_APPLIED" as const, settings: previous, receipt: existingReceipt };
    }
    const commandFence = previous.productCommandFences?.[payload.commandHandle];
    if (!commandFence || commandFence.intentId !== payload.intentId ||
        commandFence.attemptId !== payload.attemptId || commandFence.fence !== payload.fence ||
        commandFence.payloadDigest !== payload.payloadDigest)
      return { status: "CONFLICT" as const };
    const priorPersonRevision = previous.personRevisionById?.[payload.personId] ?? null;
    const priorPrimaryRevision = previous.primaryPersonRevision ?? null;
    if (priorPrimaryRevision !== payload.expectedPrimaryRevision ||
        priorPersonRevision !== payload.expectedPersonRevision)
      return { status: "CONFLICT" as const };
    const existingPerson = previous.people.find((person) => person.id === payload.personId);
    if ((payload.operation === "CREATE" && existingPerson) ||
        (payload.operation === "UPDATE" && !existingPerson))
      return { status: "CONFLICT" as const };
    const person: Person = {
      id: payload.personId,
      displayName: payload.displayName,
      personaId: payload.personaId,
      notes: payload.notes
    };
    const candidate: ProductSettings = {
      ...previous,
      people: [...previous.people.filter((entry) => entry.id !== person.id), person],
      primaryPersonId: payload.requestedPrimary
        ? person.id
        : previous.primaryPersonId === person.id
          ? null
          : previous.primaryPersonId
    };
    const committed = commitProductSettings(candidate, previous);
    const resultingPersonRevision = committed.personRevisionById?.[person.id];
    if (!resultingPersonRevision) return { status: "UNKNOWN" as const };
    const receipt: ProductPersonCommandReceipt = Object.freeze({
      version: "product-person-command-application.v1",
      commandHandle: payload.commandHandle,
      intentId: payload.intentId,
      attemptId: payload.attemptId,
      fence: payload.fence,
      payloadDigest: payload.payloadDigest,
      causalRefs: payload.causalRefs.map((ref) => ({ ...ref })),
      personId: person.id,
      priorPersonRevision,
      resultingPersonRevision,
      priorPrimaryRevision,
      resultingPrimaryRevision: committed.primaryPersonRevision ?? null
    });
    const next = {
      ...committed,
      productCommandReceipts: [...(previous.productCommandReceipts ?? []), receipt]
    };
    writeProductSettings(next);
    return { status: "APPLIED" as const, settings: next, receipt };
  });
}

/** Exact owner lookup after a dispatch-start ambiguity; registering the current fence quiesces older writers. */
export async function reconcileProductPersonCommand(input: {
  payload: ProductPersonCommandPayload;
  attemptId: string;
  fence: string;
}): Promise<ProductPersonCommandApplyResult> {
  const fenced = await fenceProductPersonCommand({
    commandHandle: input.payload.commandHandle,
    intentId: input.payload.intentId,
    attemptId: input.attemptId,
    fence: input.fence,
    payloadDigest: input.payload.payloadDigest
  });
  if (fenced !== "READY") return { status: "UNKNOWN" };
  return withProductSettingsOwner(() => {
    const current = readProductSettings() ?? defaultProductSettings();
    const receipt = current.productCommandReceipts?.find(
      (item) => item.commandHandle === input.payload.commandHandle
    );
    if (receipt) {
      if (
        receipt.payloadDigest !== input.payload.payloadDigest ||
        receipt.intentId !== input.payload.intentId ||
        receipt.attemptId !== input.attemptId ||
        BigInt(receipt.fence) > BigInt(input.fence)
      ) return { status: "UNKNOWN" as const };
      return { status: "ALREADY_APPLIED" as const, settings: current, receipt };
    }
    const personRevision = current.personRevisionById?.[input.payload.personId] ?? null;
    const primaryRevision = current.primaryPersonRevision ?? null;
    if (personRevision !== input.payload.expectedPersonRevision ||
        primaryRevision !== input.payload.expectedPrimaryRevision)
      return { status: "UNKNOWN" as const };
    const personExists = current.people.some((person) => person.id === input.payload.personId);
    if ((input.payload.operation === "CREATE" && personExists) ||
        (input.payload.operation === "UPDATE" && !personExists))
      return { status: "UNKNOWN" as const };
    return { status: "PROVEN_NOT_APPLIED" as const, reason: "NO_COMMAND_RECEIPT_AFTER_FENCE" as const };
  });
}
export function defaultProductSettings(): ProductSettings { return { configuration: emptyProductConfiguration(), people: [], primaryPersonId: null, proactive: { threshold: .7, intervalMs: 60_000 }, revision: 0 }; }
export function productEnvironment(env: Record<string, string | undefined>, settings: ProductSettings | null): Record<string, string | undefined> {
  if (!settings) return env;
  // Provider routing is not process ownership. A Product-selected localhost
  // endpoint (for example an externally running 9876/9881/8128 service) only
  // selects where a capability is routed. Lifecycle ownership stays with the
  // managed service (managed endpoint/start command/autostart), so no
  // localhost allow/deny check belongs here. In particular the Portable
  // managed defaults (19876/19881/19880) keep working when selected, while an
  // explicit external Product endpoint must not be rewritten or rejected.
  const primary = settings.people.find(p => p.id === settings.primaryPersonId);
  return { ...env, YUVI_PRODUCT_CONFIGURATION: JSON.stringify(settings.configuration), MEMORY_SUBJECT_USER_ID: primary?.id, MEMORY_PERSONA_ID: primary?.personaId, PROACTIVE_SCORE_THRESHOLD: String(settings.proactive.threshold), PROACTIVE_EVALUATION_INTERVAL_MS: String(settings.proactive.intervalMs) };
}
export function embeddingSignature(c: ProductConfiguration): string {
  return JSON.stringify(c.routes.embedding.map(id => { const m = c.models.find(m => m.id === id)!; return [m, c.providers.find(p => p.id === m.providerId)]; }));
}

/** Import only configured, implemented legacy routes; never invent model metadata. */
export function importLegacyConfiguration(env: Record<string, string | undefined>): ProductSettings {
  const settings = defaultProductSettings();
  const c = settings.configuration;
  const add = (vendor: string, cap: import("@companion/providers").CapabilityRoute, baseUrl: string | undefined, modelId: string | undefined, key: string | undefined, adapter: import("@companion/providers").ProductProvider["adapter"], context?: string, dimensions?: string) => {
    if (!baseUrl || !modelId) return;
    const pid = `import-${vendor}`; const mid = `${pid}-${cap}`;
    if (!c.providers.some(p => p.id === pid)) c.providers.push({ id: pid, displayName: vendor, baseUrl, adapter, ...(key ? { apiKey: key } : {}) });
    c.models.push({ id: mid, providerId: pid, displayName: modelId, modelId, temperature: .7, contextWindow: Number.isSafeInteger(Number(context)) && Number(context) >= 1024 ? Number(context) : null, enabled: true, capabilities: [cap], ...(cap === "embedding" ? { dimensions: Number(dimensions) || 1536 } : {}), ...(cap === "chat" && env["OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT"] === "deepseek-v4" && vendor === "openai-compatible" ? { continuationFormat: "deepseek-v4" as const } : {}) });
    c.routes[cap].push(mid);
  };
  const definitions = {
    "deepseek": ["DEEPSEEK", "https://api.deepseek.com"],
    "openai-compatible": ["OPENAI_COMPATIBLE", undefined],
    "nvidia": ["NVIDIA", "https://integrate.api.nvidia.com/v1"],
    "local": ["LOCAL", env["LOCAL_MODEL_BASEURL"]]
  } as const;
  for (const cap of ["chat", "reasoning", "embedding", "vision", "stt", "tts"] as const) {
    const chain = env[`${cap.toUpperCase()}_PROVIDER_CHAIN`]?.split(",").map(x => x.trim()) ?? (cap === "chat" || cap === "reasoning" ? [env[`DEFAULT_${cap.toUpperCase()}_PROVIDER`] ?? "deepseek", "nvidia", "local"] : cap === "embedding" ? [env["EMBEDDING_PROVIDER"] ?? "openai-compatible", "nvidia", "local"] : cap === "stt" ? ["dashscope", "local"] : ["xai", "local"]);
    for (const vendor of [...new Set(chain)]) {
      if ((cap === "chat" || cap === "reasoning" || cap === "embedding") && vendor in definitions) {
        const [prefix, fallback] = definitions[vendor as keyof typeof definitions];
        const genericEmbedding = cap === "embedding" && vendor === "openai-compatible";
        const key = env[genericEmbedding ? "EMBEDDING_API_KEY" : `${prefix}_API_KEY`];
        if (vendor !== "local" && !key) continue;
        add(vendor, cap, env[genericEmbedding ? "EMBEDDING_API_BASEURL" : `${prefix}_API_BASEURL`] ?? fallback, env[genericEmbedding ? "EMBEDDING_MODEL" : `${prefix}_${cap.toUpperCase()}_MODEL`], key, "openai-compatible", env[`${prefix}_CHAT_CONTEXT_WINDOW`], env[genericEmbedding ? "EMBEDDING_DIMENSIONS" : `${prefix}_EMBEDDING_DIMENSIONS`]);
      } else if (cap === "vision" && vendor === "xai" && env["XAI_API_KEY"]) add("xai-vision", cap, env["XAI_API_BASEURL"] ?? "https://api.x.ai/v1", env["XAI_VISION_MODEL"], env["XAI_API_KEY"], "openai-compatible");
      else if (cap === "stt" && vendor === "local") add("local-stt", cap, env["LOCAL_STT_BASE_URL"], env["LOCAL_STT_MODEL"], undefined, "local-stt");
      else if (cap === "stt" && vendor === "dashscope" && env["DASHSCOPE_API_KEY"]) add("dashscope", cap, env["DASHSCOPE_API_BASEURL"] ?? "https://dashscope.aliyuncs.com/api/v1", env["DASHSCOPE_STT_MODEL"], env["DASHSCOPE_API_KEY"], "dashscope");
      else if (cap === "tts" && vendor === "xai" && env["XAI_API_KEY"]) add("xai-tts", cap, env["XAI_API_BASEURL"] ?? "https://api.x.ai/v1", env["XAI_TTS_MODEL"], env["XAI_API_KEY"], "xai-tts");
      else if (cap === "tts" && vendor === "local") add("local-tts", cap, env["LOCAL_TTS_BASE_URL"] ?? env["GPT_SOVITS_TTS_BASE_URL"] ?? "http://127.0.0.1:9881", env["LOCAL_TTS_MODEL"], undefined, env["LOCAL_TTS_MODEL"] === "dots-studio/dots.tts-soar" ? "dots-tts" : "gpt-sovits");
    }
  }
  if (env["OPENAI_COMPATIBLE_API_KEY"]) add("openai-compatible", "proactive", env["OPENAI_COMPATIBLE_API_BASEURL"], env["OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL"], env["OPENAI_COMPATIBLE_API_KEY"], "openai-compatible");
  settings.proactive = { threshold: Number(env["PROACTIVE_SCORE_THRESHOLD"] ?? .7), intervalMs: Number(env["PROACTIVE_EVALUATION_INTERVAL_MS"] ?? 60000) };
  return settings;
}
