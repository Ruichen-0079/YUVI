import type { FastifyBaseLogger } from "fastify";

export const SERVER_PLUGIN_MANIFEST_VERSION = 1 as const;
export const SERVER_PLUGIN_API_VERSION = 1 as const;
export const SERVER_PLUGIN_SOURCE_LIMIT = 32;
export const SERVER_PLUGIN_OPERATION_TIMEOUT_MS = 5_000;

const pluginManifestFields = new Set([
  "manifestVersion",
  "id",
  "version",
  "compatibility",
  "capabilities",
  "surfaces"
]);

export type ServerPluginManifest = Readonly<{
  manifestVersion: typeof SERVER_PLUGIN_MANIFEST_VERSION;
  id: string;
  /** Opaque plugin release label; A6 does not resolve or compare plugin versions. */
  version: string;
  compatibility: Readonly<{ apiVersion: number }>;
  /** Declarations only. They are not registered or exposed to Cognition. */
  capabilities?: readonly string[] | undefined;
  /** Declarations only. A6 does not attach these surfaces to product routes. */
  surfaces?:
    | Readonly<{
        presentation?: readonly string[] | undefined;
        input?: readonly string[] | undefined;
      }>
    | undefined;
}>;

export type ServerPluginLifecycleContext = Readonly<{
  manifest: ServerPluginManifest;
  signal: AbortSignal;
}>;

export type ServerPluginInstance = Readonly<{
  start(context: ServerPluginLifecycleContext): void | Promise<void>;
  stop(context: ServerPluginLifecycleContext): void | Promise<void>;
  dispose(context: ServerPluginLifecycleContext): void | Promise<void>;
}>;

/** A composition-registered source. Its loader is not called during discovery. */
export type ServerPluginSource = Readonly<{
  manifest: unknown;
  load(context: ServerPluginLifecycleContext): ServerPluginInstance | Promise<ServerPluginInstance>;
}>;

export type ServerPluginSourceDiscovery = () => readonly unknown[] | Promise<readonly unknown[]>;

export type ServerPluginPhase = "DISCOVERY" | "LOAD" | "START" | "STOP" | "DISPOSE";
export type ServerPluginState =
  | "DISCOVERED"
  | "INCOMPATIBLE"
  | "REJECTED"
  | "LOADED"
  | "STARTED"
  | "FAILED"
  | "STOPPED"
  | "DISPOSED";

export type ServerPluginDiagnostic = Readonly<{
  phase: ServerPluginPhase;
  code: string;
  message: string;
  sourceIndex?: number | undefined;
  pluginId?: string | undefined;
}>;

export type ServerPluginSnapshot = Readonly<{
  phase: "NEW" | "DISCOVERED" | "LOADED" | "STARTED" | "STOPPED" | "DISPOSED";
  plugins: readonly Readonly<{
    sourceIndex: number;
    pluginId?: string | undefined;
    version?: string | undefined;
    state: ServerPluginState;
    manifest?: ServerPluginManifest | undefined;
  }>[];
  diagnostics: readonly ServerPluginDiagnostic[];
}>;

type PluginLogger = Pick<FastifyBaseLogger, "warn">;

type PluginRecord = {
  sourceIndex: number;
  source?: ServerPluginSource | undefined;
  manifest?: ServerPluginManifest | undefined;
  state: ServerPluginState;
  instance?: ServerPluginInstance | undefined;
  startAttempted: boolean;
};

type BoundedResult<T> =
  | Readonly<{ kind: "completed"; value: T }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "timeout" }>;

export function validateServerPluginManifest(input: unknown): ServerPluginManifest {
  const value = readPlainDataObject(input, "Plugin manifest");
  assertAllowedFields(value, pluginManifestFields, "Plugin manifest");

  if (value["manifestVersion"] !== SERVER_PLUGIN_MANIFEST_VERSION) {
    throw new Error(`manifestVersion must be ${SERVER_PLUGIN_MANIFEST_VERSION}.`);
  }
  const id = requireToken(value["id"], "id", 128, /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
  const version = requireToken(value["version"], "version", 64, /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/u);
  const compatibility = readPlainDataObject(value["compatibility"], "compatibility");
  assertAllowedFields(compatibility, new Set(["apiVersion"]), "compatibility");
  const apiVersion = compatibility["apiVersion"];
  if (typeof apiVersion !== "number" || !Number.isSafeInteger(apiVersion) || apiVersion < 1) {
    throw new Error("compatibility.apiVersion must be a positive safe integer.");
  }

  const capabilities =
    value["capabilities"] === undefined
      ? undefined
      : readDeclarationList(value["capabilities"], "capabilities");
  let surfaces: ServerPluginManifest["surfaces"];
  if (value["surfaces"] !== undefined) {
    const rawSurfaces = readPlainDataObject(value["surfaces"], "surfaces");
    assertAllowedFields(rawSurfaces, new Set(["presentation", "input"]), "surfaces");
    surfaces = Object.freeze({
      ...(rawSurfaces["presentation"] === undefined
        ? {}
        : {
            presentation: readDeclarationList(rawSurfaces["presentation"], "surfaces.presentation")
          }),
      ...(rawSurfaces["input"] === undefined
        ? {}
        : { input: readDeclarationList(rawSurfaces["input"], "surfaces.input") })
    });
  }

  return Object.freeze({
    manifestVersion: SERVER_PLUGIN_MANIFEST_VERSION,
    id,
    version,
    compatibility: Object.freeze({ apiVersion }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(surfaces === undefined ? {} : { surfaces })
  });
}

/**
 * Owns only local plugin lifecycle state. Runtime, providers, Memory, P8,
 * capabilities, routes, and product configuration are deliberately absent.
 */
export class ServerPluginLifecycle {
  private phase: ServerPluginSnapshot["phase"] = "NEW";
  private readonly records: PluginRecord[] = [];
  private readonly diagnostics: ServerPluginDiagnostic[] = [];
  private readonly startOrder: PluginRecord[] = [];
  private readonly loadOrder: PluginRecord[] = [];

  constructor(
    private readonly discoverSources: ServerPluginSourceDiscovery,
    private readonly logger: PluginLogger,
    private readonly operationTimeoutMs = SERVER_PLUGIN_OPERATION_TIMEOUT_MS
  ) {
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1) {
      throw new Error("Plugin operation timeout must be a positive safe integer.");
    }
  }

  async discover(): Promise<ServerPluginSnapshot> {
    this.requirePhase("NEW", "discover");
    this.phase = "DISCOVERED";

    const discovery = await runBounded(this.operationTimeoutMs, (signal) => {
      if (signal.aborted) throw new Error("cancelled");
      return this.discoverSources();
    });
    if (discovery.kind !== "completed" || !Array.isArray(discovery.value)) {
      this.addDiagnostic({
        phase: "DISCOVERY",
        code: discovery.kind === "timeout" ? "SOURCE_DISCOVERY_TIMEOUT" : "SOURCE_DISCOVERY_FAILED",
        message: "Plugin source discovery failed; the server will continue without plugins."
      });
      return this.snapshot();
    }

    const sourceCount = Math.min(discovery.value.length, SERVER_PLUGIN_SOURCE_LIMIT);
    const parsed: PluginRecord[] = [];
    for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
      const candidate = readPluginSource(discovery.value[sourceIndex]);
      if (!candidate) {
        parsed.push({ sourceIndex, state: "REJECTED", startAttempted: false });
        this.addDiagnostic({
          phase: "DISCOVERY",
          code: "INVALID_PLUGIN_SOURCE",
          message: "Plugin source must contain a manifest and a deferred loader.",
          sourceIndex
        });
        continue;
      }
      let manifest: ServerPluginManifest;
      try {
        manifest = validateServerPluginManifest(candidate.manifest);
      } catch {
        parsed.push({ sourceIndex, source: candidate, state: "REJECTED", startAttempted: false });
        this.addDiagnostic({
          phase: "DISCOVERY",
          code: "INVALID_MANIFEST",
          message:
            "Plugin manifest failed validation; check manifest v1 fields and declaration shapes.",
          sourceIndex
        });
        continue;
      }
      parsed.push({
        sourceIndex,
        source: candidate,
        manifest,
        state:
          manifest.compatibility.apiVersion === SERVER_PLUGIN_API_VERSION
            ? "DISCOVERED"
            : "INCOMPATIBLE",
        startAttempted: false
      });
    }

    if (discovery.value.length > SERVER_PLUGIN_SOURCE_LIMIT) {
      this.addDiagnostic({
        phase: "DISCOVERY",
        code: "PLUGIN_SOURCE_LIMIT_EXCEEDED",
        message: `Only the first ${SERVER_PLUGIN_SOURCE_LIMIT} registered plugin sources are considered.`,
        sourceIndex: SERVER_PLUGIN_SOURCE_LIMIT
      });
    }

    const identityCounts = new Map<string, number>();
    for (const record of parsed) {
      if (record.manifest) {
        identityCounts.set(record.manifest.id, (identityCounts.get(record.manifest.id) ?? 0) + 1);
      }
    }
    for (const record of parsed) {
      if (!record.manifest) continue;
      if (record.manifest.compatibility.apiVersion !== SERVER_PLUGIN_API_VERSION) {
        this.addDiagnostic({
          phase: "DISCOVERY",
          code: "INCOMPATIBLE_PLUGIN_API",
          message: `Plugin requires API version ${record.manifest.compatibility.apiVersion}; this host supports ${SERVER_PLUGIN_API_VERSION}.`,
          sourceIndex: record.sourceIndex,
          pluginId: record.manifest.id
        });
      }
      if ((identityCounts.get(record.manifest.id) ?? 0) > 1) {
        record.state = "REJECTED";
        this.addDiagnostic({
          phase: "DISCOVERY",
          code: "DUPLICATE_PLUGIN_ID",
          message: "Every source with a duplicated plugin id was rejected.",
          sourceIndex: record.sourceIndex,
          pluginId: record.manifest.id
        });
      }
    }
    parsed.sort(comparePluginRecords);
    this.records.push(...parsed);
    return this.snapshot();
  }

  async load(): Promise<ServerPluginSnapshot> {
    this.requirePhase("DISCOVERED", "load");
    const eligible = this.records.filter((record) => record.state === "DISCOVERED");
    for (const record of eligible) {
      const result = await runBounded(this.operationTimeoutMs, (signal) =>
        record.source!.load(createLifecycleContext(record.manifest!, signal))
      );
      if (result.kind === "completed" && isPluginInstance(result.value)) {
        record.instance = result.value;
        record.state = "LOADED";
        this.loadOrder.push(record);
      } else {
        record.state = "FAILED";
        this.addDiagnostic({
          phase: "LOAD",
          code:
            result.kind === "timeout"
              ? "PLUGIN_LOAD_TIMEOUT"
              : result.kind === "completed"
                ? "INVALID_PLUGIN_INSTANCE"
                : "PLUGIN_LOAD_FAILED",
          message:
            result.kind === "timeout"
              ? "Plugin loading exceeded its deadline."
              : result.kind === "completed"
                ? "Plugin loader did not return start, stop, and dispose hooks."
                : "Plugin loader failed.",
          sourceIndex: record.sourceIndex,
          pluginId: record.manifest?.id
        });
      }
    }
    this.phase = "LOADED";
    return this.snapshot();
  }

  async start(): Promise<ServerPluginSnapshot> {
    this.requirePhase("LOADED", "start");
    const eligible = this.loadOrder.slice();
    for (const record of eligible) {
      record.startAttempted = true;
      this.startOrder.push(record);
      const result = await runBounded(this.operationTimeoutMs, (signal) =>
        record.instance!.start(createLifecycleContext(record.manifest!, signal))
      );
      if (result.kind === "completed") {
        record.state = "STARTED";
      } else {
        record.state = "FAILED";
        this.addDiagnostic({
          phase: "START",
          code: result.kind === "timeout" ? "PLUGIN_START_TIMEOUT" : "PLUGIN_START_FAILED",
          message:
            result.kind === "timeout"
              ? "Plugin start exceeded its deadline."
              : "Plugin start hook failed.",
          sourceIndex: record.sourceIndex,
          pluginId: record.manifest?.id
        });
      }
    }
    this.phase = "STARTED";
    return this.snapshot();
  }

  async stop(): Promise<ServerPluginSnapshot> {
    if (this.phase === "STOPPED" || this.phase === "DISPOSED") return this.snapshot();
    if (this.phase !== "STARTED" && this.phase !== "LOADED" && this.phase !== "DISCOVERED") {
      throw new Error(`Plugin lifecycle cannot stop from ${this.phase}.`);
    }

    const attempted = this.startOrder.slice().reverse();
    for (const record of attempted) {
      const result = await runBounded(this.operationTimeoutMs, (signal) =>
        record.instance!.stop(createLifecycleContext(record.manifest!, signal))
      );
      if (result.kind === "completed") {
        if (record.state !== "DISPOSED") record.state = "STOPPED";
      } else {
        record.state = "FAILED";
        this.addDiagnostic({
          phase: "STOP",
          code: result.kind === "timeout" ? "PLUGIN_STOP_TIMEOUT" : "PLUGIN_STOP_FAILED",
          message:
            result.kind === "timeout"
              ? "Plugin stop exceeded its deadline."
              : "Plugin stop hook failed.",
          sourceIndex: record.sourceIndex,
          pluginId: record.manifest?.id
        });
      }
    }
    this.phase = "STOPPED";
    return this.snapshot();
  }

  async dispose(): Promise<ServerPluginSnapshot> {
    if (this.phase === "DISPOSED") return this.snapshot();
    if (this.phase === "STARTED") await this.stop();
    if (this.phase === "NEW") {
      this.phase = "DISPOSED";
      return this.snapshot();
    }
    if (this.phase !== "DISCOVERED" && this.phase !== "LOADED" && this.phase !== "STOPPED") {
      throw new Error(`Plugin lifecycle cannot dispose from ${this.phase}.`);
    }

    const loaded = this.loadOrder.slice().reverse();
    for (const record of loaded) {
      const result = await runBounded(this.operationTimeoutMs, (signal) =>
        record.instance!.dispose(createLifecycleContext(record.manifest!, signal))
      );
      if (result.kind !== "completed") {
        this.addDiagnostic({
          phase: "DISPOSE",
          code: result.kind === "timeout" ? "PLUGIN_DISPOSE_TIMEOUT" : "PLUGIN_DISPOSE_FAILED",
          message:
            result.kind === "timeout"
              ? "Plugin dispose exceeded its deadline."
              : "Plugin dispose hook failed.",
          sourceIndex: record.sourceIndex,
          pluginId: record.manifest?.id
        });
      }
      // Disposal is terminal even when a hook fails; the failed attempt remains
      // visible in diagnostics and the host releases its plugin reference.
      record.instance = undefined;
      record.state = "DISPOSED";
    }
    for (const record of this.records) {
      if (
        record.state === "DISCOVERED" ||
        record.state === "LOADED" ||
        record.state === "STOPPED"
      ) {
        record.instance = undefined;
        record.state = "DISPOSED";
      }
    }
    this.phase = "DISPOSED";
    return this.snapshot();
  }

  async shutdown(): Promise<ServerPluginSnapshot> {
    if (this.phase === "DISPOSED") return this.snapshot();
    if (this.phase === "STARTED" || this.phase === "LOADED" || this.phase === "DISCOVERED") {
      await this.stop();
    }
    return this.dispose();
  }

  snapshot(): ServerPluginSnapshot {
    return Object.freeze({
      phase: this.phase,
      plugins: Object.freeze(
        this.records.map((record) =>
          Object.freeze({
            sourceIndex: record.sourceIndex,
            ...(record.manifest === undefined ? {} : { pluginId: record.manifest.id }),
            ...(record.manifest === undefined ? {} : { version: record.manifest.version }),
            state: record.state,
            ...(record.manifest === undefined ? {} : { manifest: record.manifest })
          })
        )
      ),
      diagnostics: Object.freeze(this.diagnostics.slice())
    });
  }

  private requirePhase(expected: ServerPluginSnapshot["phase"], operation: string): void {
    if (this.phase !== expected) {
      throw new Error(
        `Plugin lifecycle cannot ${operation} from ${this.phase}; expected ${expected}.`
      );
    }
  }

  private addDiagnostic(diagnostic: ServerPluginDiagnostic): void {
    const safe = Object.freeze(diagnostic);
    this.diagnostics.push(safe);
    this.logger.warn(
      {
        ...(safe.pluginId === undefined ? {} : { pluginId: safe.pluginId }),
        ...(safe.sourceIndex === undefined ? {} : { sourceIndex: safe.sourceIndex }),
        phase: safe.phase,
        code: safe.code
      },
      safe.message
    );
  }
}

function readPluginSource(input: unknown): ServerPluginSource | undefined {
  let value: Record<string, unknown>;
  try {
    value = readPlainDataObject(input, "Plugin source");
    assertAllowedFields(value, new Set(["manifest", "load"]), "Plugin source");
  } catch {
    return undefined;
  }
  if (typeof value["load"] !== "function" || !("manifest" in value)) return undefined;
  return Object.freeze({
    manifest: value["manifest"],
    load: value["load"] as ServerPluginSource["load"]
  });
}

function readPlainDataObject(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${field} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} must be a plain object.`);
  }
  const value: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") throw new Error(`${field} contains an unsupported field.`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`${field} contains an accessor-backed field.`);
    }
    value[key] = descriptor.value;
  }
  return value;
}

function assertAllowedFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string
): void {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`${field} contains an unsupported field.`);
  }
}

function requireToken(input: unknown, field: string, maxLength: number, pattern: RegExp): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maxLength ||
    input.trim() !== input ||
    !pattern.test(input)
  ) {
    throw new Error(`${field} must be a valid token of at most ${maxLength} characters.`);
  }
  return input;
}

function readDeclarationList(input: unknown, field: string): readonly string[] {
  if (!Array.isArray(input)) throw new Error(`${field} must be an array of declaration ids.`);
  if (input.length > 64) throw new Error(`${field} must contain no more than 64 declarations.`);
  const declarations: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`${field}[${index}] must be a data value.`);
    }
    const item = requireToken(
      descriptor.value,
      `${field}[${index}]`,
      160,
      /^[a-z0-9][a-z0-9._:/-]*$/u
    );
    if (seen.has(item)) throw new Error(`${field} contains duplicate declarations.`);
    seen.add(item);
    declarations.push(item);
  }
  return Object.freeze(declarations);
}

function comparePluginRecords(left: PluginRecord, right: PluginRecord): number {
  const leftId = left.manifest?.id ?? "\uffff";
  const rightId = right.manifest?.id ?? "\uffff";
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  return left.sourceIndex - right.sourceIndex;
}

function createLifecycleContext(
  manifest: ServerPluginManifest,
  signal: AbortSignal
): ServerPluginLifecycleContext {
  return Object.freeze({ manifest, signal });
}

function isPluginInstance(input: unknown): input is ServerPluginInstance {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  try {
    const instance = input as Record<string, unknown>;
    return (
      typeof instance["start"] === "function" &&
      typeof instance["stop"] === "function" &&
      typeof instance["dispose"] === "function"
    );
  } catch {
    return false;
  }
}

async function runBounded<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => T | Promise<T>
): Promise<BoundedResult<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  const observed = operationPromise.then(
    (value) => ({ kind: "completed", value }) as const,
    () => ({ kind: "failed" }) as const
  );
  const timeout = new Promise<BoundedResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const result = await Promise.race([observed, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (result.kind === "timeout") controller.abort();
  return result;
}
