import type { FastifyBaseLogger } from "fastify";
import {
  assertServerPluginCapabilityGrant,
  type ServerPluginCapabilityGrant
} from "./mcp-capability-binding.js";

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
  /** Host-issued handles only; plugin declarations do not create these grants. */
  capabilityRegistrations?: readonly ServerPluginCapabilityRegistration[] | undefined;
}>;

export type ServerPluginCapabilityImplementation = (
  request: string,
  signal: AbortSignal
) => string | Promise<string>;

export type ServerPluginCapabilityRegistration = Readonly<{
  capabilityRef: string;
  description: string;
  implementationRef: string;
  register(implementation: ServerPluginCapabilityImplementation): void;
}>;

export type ServerPluginRuntimeCapability = Readonly<{
  capabilityRef: string;
  description: string;
}>;

/** Host-only view consumed by the Runtime-facing Cognition composition. */
export type ServerPluginRuntimeCapabilitySurface = Readonly<{
  snapshot(): readonly ServerPluginRuntimeCapability[];
  invoke(capabilityRef: string, request: string, signal: AbortSignal): Promise<string>;
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
  | "DRAINING"
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
  phase: "NEW" | "DISCOVERED" | "LOADED" | "STARTED" | "DRAINING" | "STOPPED" | "DISPOSED";
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
  capabilityScope?: PluginCapabilityScope | undefined;
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
 * Owns local plugin lifecycle state and per-plugin registration scopes. Runtime,
 * providers, Memory, P8, routes, and product configuration are absent from the
 * supported plugin context; Runtime receives a separate host-only view.
 */
export class ServerPluginLifecycle {
  private phase: ServerPluginSnapshot["phase"] = "NEW";
  private readonly records: PluginRecord[] = [];
  private readonly diagnostics: ServerPluginDiagnostic[] = [];
  private readonly startOrder: PluginRecord[] = [];
  private readonly loadOrder: PluginRecord[] = [];
  private readonly capabilityGrants: readonly ServerPluginCapabilityGrant[];
  private stopHooksPromise: Promise<void> | undefined;
  private disposeHooksPromise: Promise<void> | undefined;
  private deferredStop: Promise<void> | undefined;
  private deferredStopFinished = false;
  private disposeAfterDeferredStop = false;
  private shutdownRequested = false;
  private readonly runtimeCapabilitySurface: ServerPluginRuntimeCapabilitySurface;

  constructor(
    private readonly discoverSources: ServerPluginSourceDiscovery,
    private readonly logger: PluginLogger,
    private readonly operationTimeoutMs = SERVER_PLUGIN_OPERATION_TIMEOUT_MS,
    capabilityGrants: readonly ServerPluginCapabilityGrant[] = []
  ) {
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1) {
      throw new Error("Plugin operation timeout must be a positive safe integer.");
    }
    const capabilityRefs = new Set<string>();
    const implementationRefs = new Set<string>();
    const scopedGrantIds = new Set<string>();
    const grants = Array.from(capabilityGrants);
    if (grants.length > 31) {
      throw new Error(
        "Plugin capability policy must leave room for the existing Runtime read-text capability."
      );
    }
    for (const grant of grants) {
      assertServerPluginCapabilityGrant(grant);
      const scopedId = `${grant.pluginId}@${grant.pluginVersion}:${grant.descriptor.capabilityRef}`;
      if (
        capabilityRefs.has(grant.descriptor.capabilityRef) ||
        implementationRefs.has(grant.descriptor.implementationRef) ||
        scopedGrantIds.has(scopedId)
      ) {
        throw new Error("Plugin capability policy contains duplicate registration identities.");
      }
      capabilityRefs.add(grant.descriptor.capabilityRef);
      implementationRefs.add(grant.descriptor.implementationRef);
      scopedGrantIds.add(scopedId);
    }
    this.capabilityGrants = Object.freeze(grants.slice());
    this.runtimeCapabilitySurface = Object.freeze({
      snapshot: () => this.snapshotExecutableCapabilities(),
      invoke: (capabilityRef: string, request: string, signal: AbortSignal) =>
        this.invokeExecutableCapability(capabilityRef, request, signal)
    });
  }

  /** This host-only view is never included in plugin lifecycle context. */
  get runtimeCapabilities(): ServerPluginRuntimeCapabilitySurface {
    return this.runtimeCapabilitySurface;
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
        startAttempted: false,
        capabilityScope: this.createCapabilityScope(manifest)
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
        record.source!.load(
          createLifecycleContext(record.manifest!, signal, record.capabilityScope)
        )
      );
      if (result.kind === "completed" && isPluginInstance(result.value)) {
        record.instance = result.value;
        record.state = "LOADED";
        this.loadOrder.push(record);
      } else {
        record.capabilityScope?.revoke();
        record.capabilityScope?.dispose();
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
        record.instance!.start(
          createLifecycleContext(record.manifest!, signal, record.capabilityScope)
        )
      );
      const registrationsCommitted =
        result.kind === "completed" && (record.capabilityScope?.commit() ?? true);
      if (registrationsCommitted) {
        record.state = "STARTED";
      } else {
        record.capabilityScope?.revoke();
        record.state = "FAILED";
        this.addDiagnostic({
          phase: "START",
          code:
            result.kind === "timeout"
              ? "PLUGIN_START_TIMEOUT"
              : result.kind === "completed" && record.capabilityScope?.registrationFailed
                ? "PLUGIN_REGISTRATION_FAILED"
                : "PLUGIN_START_FAILED",
          message:
            result.kind === "timeout"
              ? "Plugin start exceeded its deadline."
              : result.kind === "completed" && record.capabilityScope?.registrationFailed
                ? "Plugin registration failed; all registrations from this plugin were discarded."
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
    if (this.phase === "STOPPED" || this.phase === "DRAINING" || this.phase === "DISPOSED") {
      return this.snapshot();
    }
    if (this.phase !== "STARTED" && this.phase !== "LOADED" && this.phase !== "DISCOVERED") {
      throw new Error(`Plugin lifecycle cannot stop from ${this.phase}.`);
    }

    this.revokeCapabilityIngress();
    const drained = await this.drainCapabilityCalls();
    if (!drained) {
      this.phase = "DRAINING";
      for (const record of this.records) {
        if (record.state === "STARTED") record.state = "DRAINING";
      }
      this.scheduleDeferredStop();
      return this.snapshot();
    }
    await this.stopStartedPlugins();
    this.phase = "STOPPED";
    return this.snapshot();
  }

  private stopStartedPlugins(): Promise<void> {
    this.stopHooksPromise ??= this.runStopHooks();
    return this.stopHooksPromise;
  }

  private async runStopHooks(): Promise<void> {
    const attempted = this.startOrder.slice().reverse();
    for (const record of attempted) {
      const result = await runBounded(this.operationTimeoutMs, (signal) =>
        record.instance!.stop(
          createLifecycleContext(record.manifest!, signal, record.capabilityScope)
        )
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
  }

  async dispose(): Promise<ServerPluginSnapshot> {
    if (this.phase === "DISPOSED") return this.snapshot();
    if (this.phase === "STARTED") await this.stop();
    if (this.deferredStop !== undefined) {
      this.disposeAfterDeferredStop = true;
      if (this.deferredStopFinished) {
        await this.disposeLoadedPlugins();
        this.phase = "DISPOSED";
      }
      return this.snapshot();
    }
    if (this.phase === "NEW") {
      this.phase = "DISPOSED";
      return this.snapshot();
    }
    if (this.phase !== "DISCOVERED" && this.phase !== "LOADED" && this.phase !== "STOPPED") {
      throw new Error(`Plugin lifecycle cannot dispose from ${this.phase}.`);
    }

    await this.disposeLoadedPlugins();
    this.phase = "DISPOSED";
    return this.snapshot();
  }

  private disposeLoadedPlugins(): Promise<void> {
    this.disposeHooksPromise ??= this.runDisposeHooks();
    return this.disposeHooksPromise;
  }

  private async runDisposeHooks(): Promise<void> {
    const loaded = this.loadOrder.slice().reverse();
    for (const record of loaded) {
      const result = await runBounded(this.operationTimeoutMs, (signal) =>
        record.instance!.dispose(
          createLifecycleContext(record.manifest!, signal, record.capabilityScope)
        )
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
    for (const record of this.records) record.capabilityScope?.dispose();
  }

  async shutdown(): Promise<ServerPluginSnapshot> {
    if (this.phase === "DISPOSED") return this.snapshot();
    this.shutdownRequested = true;
    this.disposeAfterDeferredStop = true;
    if (this.phase === "STARTED" || this.phase === "LOADED" || this.phase === "DISCOVERED") {
      await this.stop();
    }
    if (this.deferredStop !== undefined) return this.snapshot();
    return this.dispose();
  }

  private createCapabilityScope(manifest: ServerPluginManifest): PluginCapabilityScope | undefined {
    const grants = this.capabilityGrants.filter(
      (grant) => grant.pluginId === manifest.id && grant.pluginVersion === manifest.version
    );
    const hasOtherVersionGrant = this.capabilityGrants.some(
      (grant) => grant.pluginId === manifest.id && grant.pluginVersion !== manifest.version
    );
    if (hasOtherVersionGrant && grants.length === 0) {
      this.addDiagnostic({
        phase: "DISCOVERY",
        code: "PLUGIN_REGISTRATION_POLICY_VERSION_MISMATCH",
        message: "Plugin capability policy does not match the discovered plugin version.",
        pluginId: manifest.id
      });
    }
    return grants.length === 0 ? undefined : new PluginCapabilityScope(grants);
  }

  private snapshotExecutableCapabilities(): readonly ServerPluginRuntimeCapability[] {
    const capabilities = this.records.flatMap((record) =>
      record.state === "STARTED" ? (record.capabilityScope?.snapshot() ?? []) : []
    );
    return Object.freeze(capabilities);
  }

  private invokeExecutableCapability(
    capabilityRef: string,
    request: string,
    signal: AbortSignal
  ): Promise<string> {
    const record = this.records.find(
      (candidate) => candidate.state === "STARTED" && candidate.capabilityScope?.has(capabilityRef)
    );
    if (!record?.capabilityScope) {
      return Promise.reject(new Error("Plugin capability registration is unavailable."));
    }
    return record.capabilityScope.invoke(capabilityRef, request, signal);
  }

  private revokeCapabilityIngress(): void {
    for (const record of this.records) record.capabilityScope?.revoke();
  }

  private async drainCapabilityCalls(): Promise<boolean> {
    const active = this.records.filter((record) => (record.capabilityScope?.inFlight ?? 0) > 0);
    const results = await Promise.all(
      active.map(async (record) => {
        const drained = await record.capabilityScope!.waitForDrain(this.operationTimeoutMs);
        if (!drained) {
          this.addDiagnostic({
            phase: "STOP",
            code: "PLUGIN_CAPABILITY_DRAIN_TIMEOUT",
            message:
              "Plugin capability calls did not settle before shutdown; implementation disposal is deferred until they settle.",
            sourceIndex: record.sourceIndex,
            pluginId: record.manifest?.id
          });
        }
        return drained;
      })
    );
    return results.every(Boolean);
  }

  private scheduleDeferredStop(): void {
    if (this.deferredStop !== undefined) return;
    const scopes = this.records.flatMap((record) =>
      record.capabilityScope && record.capabilityScope.inFlight > 0 ? [record.capabilityScope] : []
    );
    this.deferredStop = Promise.all(scopes.map((scope) => scope.waitUntilDrained()))
      .then(async () => {
        await this.stopStartedPlugins();
        this.deferredStopFinished = true;
        if (this.disposeAfterDeferredStop || this.shutdownRequested) {
          await this.disposeLoadedPlugins();
          this.phase = "DISPOSED";
        }
      })
      .catch(() => {
        this.deferredStopFinished = true;
      });
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
  signal: AbortSignal,
  capabilityScope?: PluginCapabilityScope | undefined
): ServerPluginLifecycleContext {
  return Object.freeze({
    manifest,
    signal,
    ...(capabilityScope === undefined
      ? {}
      : { capabilityRegistrations: capabilityScope.registrations })
  });
}

type PluginCapabilityScopeState = "STAGING" | "ACTIVE" | "REVOKED" | "DISPOSED";

class PluginCapabilityScope {
  private readonly slots = new Map<
    string,
    {
      grant: ServerPluginCapabilityGrant;
      implementation: ServerPluginCapabilityImplementation | undefined;
    }
  >();
  private readonly drainListeners = new Set<() => void>();
  private state: PluginCapabilityScopeState = "STAGING";
  private activeCalls = 0;
  registrationFailed = false;
  readonly registrations: readonly ServerPluginCapabilityRegistration[];

  constructor(grants: readonly ServerPluginCapabilityGrant[]) {
    const registrations = grants.map((grant) => {
      this.slots.set(grant.descriptor.capabilityRef, { grant, implementation: undefined });
      return Object.freeze({
        capabilityRef: grant.descriptor.capabilityRef,
        description: grant.descriptor.description,
        implementationRef: grant.descriptor.implementationRef,
        register: (implementation: ServerPluginCapabilityImplementation) =>
          this.register(grant.descriptor.capabilityRef, implementation)
      });
    });
    this.registrations = Object.freeze(registrations);
  }

  get inFlight(): number {
    return this.activeCalls;
  }

  register(capabilityRef: string, implementation: ServerPluginCapabilityImplementation): void {
    if (this.state !== "STAGING") {
      throw new Error("Plugin capability registration is closed.");
    }
    const slot = this.slots.get(capabilityRef);
    if (slot === undefined || typeof implementation !== "function" || slot.implementation) {
      this.registrationFailed = true;
      for (const candidate of this.slots.values()) candidate.implementation = undefined;
      throw new Error("Plugin capability registration did not match its host-issued handle.");
    }
    slot.implementation = implementation;
  }

  commit(): boolean {
    if (this.state !== "STAGING" || this.registrationFailed) return false;
    this.state = "ACTIVE";
    return true;
  }

  revoke(): void {
    if (this.state === "DISPOSED" || this.state === "REVOKED") return;
    this.state = "REVOKED";
    if (this.activeCalls === 0) this.clearImplementations();
  }

  dispose(): void {
    if (this.activeCalls > 0) {
      throw new Error(
        "Cannot dispose plugin capability implementations while calls are in flight."
      );
    }
    this.state = "DISPOSED";
    this.clearImplementations();
    this.slots.clear();
  }

  has(capabilityRef: string): boolean {
    return this.state === "ACTIVE" && this.slots.get(capabilityRef)?.implementation !== undefined;
  }

  snapshot(): readonly ServerPluginRuntimeCapability[] {
    if (this.state !== "ACTIVE") return Object.freeze([]);
    return Object.freeze(
      Array.from(this.slots.values())
        .filter((slot) => slot.implementation !== undefined)
        .map((slot) =>
          Object.freeze({
            capabilityRef: slot.grant.descriptor.capabilityRef,
            description: slot.grant.descriptor.description
          })
        )
    );
  }

  async invoke(capabilityRef: string, request: string, signal: AbortSignal): Promise<string> {
    const slot = this.slots.get(capabilityRef);
    const implementation = slot?.implementation;
    if (this.state !== "ACTIVE" || implementation === undefined) {
      throw new Error("Plugin capability registration is unavailable.");
    }
    signal.throwIfAborted();
    this.activeCalls += 1;
    try {
      const result = await implementation(request, signal);
      if (typeof result !== "string") {
        throw new Error("Plugin capability result must be text.");
      }
      return result;
    } finally {
      this.activeCalls -= 1;
      if (this.activeCalls === 0) {
        if ((this.state as PluginCapabilityScopeState) === "REVOKED") this.clearImplementations();
        for (const listener of this.drainListeners) listener();
        this.drainListeners.clear();
      }
    }
  }

  waitForDrain(timeoutMs: number): Promise<boolean> {
    if (this.activeCalls === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const listener = () => {
        clearTimeout(timer);
        this.drainListeners.delete(listener);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.drainListeners.delete(listener);
        resolve(this.activeCalls === 0);
      }, timeoutMs);
      this.drainListeners.add(listener);
    });
  }

  waitUntilDrained(): Promise<void> {
    if (this.activeCalls === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainListeners.add(resolve);
    });
  }

  private clearImplementations(): void {
    for (const slot of this.slots.values()) slot.implementation = undefined;
  }
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
