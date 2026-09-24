import {
  COGNITION_6G_VERSION,
  createCognitionCapabilityDescriptions,
  createCognitionCapabilityRequest,
  type CognitionCapabilityDescriptionSet,
  type CognitionCapabilityRequest
} from "@companion/cognition";
import type { ServerMcpTool } from "./mcp-client.js";

export const SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION =
  "server-executable-capability-registry-a7.1.v1" as const;
export const SERVER_MCP_CAPABILITY_DESCRIPTOR_A71_VERSION =
  "server-mcp-capability-descriptor-a7.1.v1" as const;
export const SERVER_MCP_EFFECT_CONTRACT_A71_VERSION = "server-mcp-effect-contract-a7.1.v1" as const;
export const SERVER_PLUGIN_CAPABILITY_GRANT_A72_VERSION =
  "server-plugin-capability-grant-a7.2.v1" as const;

/** Existing 6K import name retained for internal call-site compatibility. */
export const SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION =
  SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION;

export const SERVER_MCP_READ_TEXT_IMPLEMENTATION_REF = "yuvi.server.mcp.read_text_file.v1" as const;
export const SERVER_MCP_READ_TEXT_CAPABILITY_REF =
  "capability://opaque/read-authorized-text" as const;

export type ServerMcpCapabilityEffectContract = Readonly<{
  version: typeof SERVER_MCP_EFFECT_CONTRACT_A71_VERSION;
  requiredPermission:
    | "RUNTIME_AUTHORIZED_PATH_READ"
    | "RUNTIME_AUTHORIZED_REMOTE_READ"
    | "RUNTIME_ADMITTED_LOCAL_TRANSFORM";
  actionKind: "QUERY" | "TRANSFORM" | "DELIVER" | "MUTATE" | "ACTUATE";
  effectLocus: "PROCESS" | "LOCAL_DURABLE_STORE" | "REMOTE_SERVICE" | "PHYSICAL_WORLD";
  dataDisclosure:
    | "NONE"
    | "AUTHORIZED_RESULT_TO_REASONING_PROVIDER"
    | "AUTHORIZED_REQUEST_TO_LOCAL_PLUGIN"
    | "REQUEST_TO_REMOTE_SERVICE"
    | "UNKNOWN";
  reversibility: "REVERSIBLE" | "COMPENSATABLE" | "IRREVERSIBLE" | "UNKNOWN";
  idempotency:
    | Readonly<{ kind: "NONE" | "UNKNOWN" | "UNSUPPORTED" }>
    | Readonly<{
        kind: "ADAPTER_CERTIFIED_KEY";
        contractVersion: string;
        namespace: string;
        payloadEquality: "EXACT_CANONICAL_PAYLOAD";
        retentionMs: number;
      }>;
  reconciliation:
    | Readonly<{ kind: "UNSUPPORTED" | "UNKNOWN" }>
    | Readonly<{
        kind: "VERSIONED_LOOKUP";
        contractVersion: string;
        establishes: readonly string[];
      }>;
  inputSchemaVersion: string;
  outputSchemaVersion: string;
}>;

export type ServerPluginCapabilityGrant = Readonly<{
  version: typeof SERVER_PLUGIN_CAPABILITY_GRANT_A72_VERSION;
  pluginId: string;
  pluginVersion: string;
  descriptor: ServerMcpCapabilityDescriptor;
}>;

export type ServerMcpCapabilityDescriptor = Readonly<{
  version: typeof SERVER_MCP_CAPABILITY_DESCRIPTOR_A71_VERSION;
  capabilityRef: string;
  description: string;
  implementationRef: string;
  effectContract: ServerMcpCapabilityEffectContract;
}>;

export type ServerMcpCapabilityBinding = Readonly<{
  capabilityRef: string;
  implementationRef: string;
  /** Concrete MCP routing remains host-owned infrastructure data. */
  toolName: string;
}>;

export type ServerMcpCapabilityBindings = Readonly<{
  version: typeof SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION;
  descriptors: readonly ServerMcpCapabilityDescriptor[];
  descriptions: CognitionCapabilityDescriptionSet;
  bindings: readonly ServerMcpCapabilityBinding[];
}>;

export type ServerMcpBoundCapabilityRequest = Readonly<{
  version: typeof SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION;
  implementationRef: string;
  toolName: string;
  request: string;
}>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  capabilities?: unknown;
  descriptorVersion?: unknown;
  capabilityRef?: unknown;
  description?: unknown;
  implementationRef?: unknown;
  requiredPermission?: unknown;
  actionKind?: unknown;
  effectLocus?: unknown;
  dataDisclosure?: unknown;
  reversibility?: unknown;
  idempotency?: unknown;
  reconciliation?: unknown;
  inputSchemaVersion?: unknown;
  outputSchemaVersion?: unknown;
  kind?: unknown;
  contractVersion?: unknown;
  namespace?: unknown;
  payloadEquality?: unknown;
  retentionMs?: unknown;
  establishes?: unknown;
};

type ApprovedImplementation = Readonly<{
  toolName: "read_text_file";
  effectContract: ServerMcpCapabilityEffectContract;
}>;

const SERVER_READ_TEXT_EFFECT_CONTRACT = validateServerMcpCapabilityEffectContract({
  version: SERVER_MCP_EFFECT_CONTRACT_A71_VERSION,
  requiredPermission: "RUNTIME_AUTHORIZED_PATH_READ",
  actionKind: "QUERY",
  effectLocus: "LOCAL_DURABLE_STORE",
  dataDisclosure: "AUTHORIZED_RESULT_TO_REASONING_PROVIDER",
  reversibility: "UNKNOWN",
  idempotency: { kind: "NONE" },
  reconciliation: { kind: "UNSUPPORTED" },
  inputSchemaVersion: "server-mcp-read-text-input.v1",
  outputSchemaVersion: "server-mcp-read-text-observation.v1"
});

const SERVER_PLUGIN_LOCAL_TRANSFORM_EFFECT_CONTRACT = validateServerMcpCapabilityEffectContract({
  version: SERVER_MCP_EFFECT_CONTRACT_A71_VERSION,
  requiredPermission: "RUNTIME_ADMITTED_LOCAL_TRANSFORM",
  actionKind: "TRANSFORM",
  effectLocus: "PROCESS",
  dataDisclosure: "AUTHORIZED_REQUEST_TO_LOCAL_PLUGIN",
  reversibility: "REVERSIBLE",
  idempotency: { kind: "NONE" },
  reconciliation: { kind: "UNSUPPORTED" },
  inputSchemaVersion: "server-plugin-local-transform-input.v1",
  outputSchemaVersion: "server-plugin-local-transform-output.v1"
});

/** The only implementation A7.1 registers; discovery cannot add to this table. */
const APPROVED_IMPLEMENTATIONS: ReadonlyMap<string, ApprovedImplementation> = new Map([
  [
    SERVER_MCP_READ_TEXT_IMPLEMENTATION_REF,
    Object.freeze({ toolName: "read_text_file", effectContract: SERVER_READ_TEXT_EFFECT_CONTRACT })
  ]
]);

const issuedRegistries = new WeakSet<object>();
const issuedPluginCapabilityGrants = new WeakSet<object>();

/**
 * Validate and freeze one explicit effect contract. UNKNOWN and UNSUPPORTED are
 * valid only as explicit classifications; omitted or unrecognized semantics
 * fail closed. This validator grants no implementation or execution authority.
 */
export function validateServerMcpCapabilityEffectContract(
  input: unknown
): ServerMcpCapabilityEffectContract {
  const value = expectObject(input, "Capability effect contract");
  assertAllowedKeys(
    value,
    [
      "version",
      "requiredPermission",
      "actionKind",
      "effectLocus",
      "dataDisclosure",
      "reversibility",
      "idempotency",
      "reconciliation",
      "inputSchemaVersion",
      "outputSchemaVersion"
    ],
    "Capability effect contract"
  );
  if (value.version !== SERVER_MCP_EFFECT_CONTRACT_A71_VERSION) {
    throw new Error(
      `Capability effect contract version must be ${SERVER_MCP_EFFECT_CONTRACT_A71_VERSION}.`
    );
  }

  const requiredPermission = expectEnum(
    value.requiredPermission,
    [
      "RUNTIME_AUTHORIZED_PATH_READ",
      "RUNTIME_AUTHORIZED_REMOTE_READ",
      "RUNTIME_ADMITTED_LOCAL_TRANSFORM"
    ],
    "Capability effect contract requiredPermission"
  );
  const actionKind = expectEnum(
    value.actionKind,
    ["QUERY", "TRANSFORM", "DELIVER", "MUTATE", "ACTUATE"],
    "Capability effect contract actionKind"
  );
  const effectLocus = expectEnum(
    value.effectLocus,
    ["PROCESS", "LOCAL_DURABLE_STORE", "REMOTE_SERVICE", "PHYSICAL_WORLD"],
    "Capability effect contract effectLocus"
  );
  const dataDisclosure = expectEnum(
    value.dataDisclosure,
    [
      "NONE",
      "AUTHORIZED_RESULT_TO_REASONING_PROVIDER",
      "AUTHORIZED_REQUEST_TO_LOCAL_PLUGIN",
      "REQUEST_TO_REMOTE_SERVICE",
      "UNKNOWN"
    ],
    "Capability effect contract dataDisclosure"
  );
  const reversibility = expectEnum(
    value.reversibility,
    ["REVERSIBLE", "COMPENSATABLE", "IRREVERSIBLE", "UNKNOWN"],
    "Capability effect contract reversibility"
  );

  const idempotency = validateIdempotency(value.idempotency);
  const reconciliation = validateReconciliation(value.reconciliation);

  return Object.freeze({
    version: SERVER_MCP_EFFECT_CONTRACT_A71_VERSION,
    requiredPermission,
    actionKind,
    effectLocus,
    dataDisclosure,
    reversibility,
    idempotency,
    reconciliation,
    inputSchemaVersion: requireToken(value.inputSchemaVersion, "inputSchemaVersion"),
    outputSchemaVersion: requireToken(value.outputSchemaVersion, "outputSchemaVersion")
  });
}

/**
 * Create one composition-root policy grant for a local, in-process transform.
 * Plugins receive only the resulting scoped registration handle; effect
 * authority and implementation identity remain host-authored.
 */
export function createServerPluginCapabilityGrant(input: unknown): ServerPluginCapabilityGrant {
  const value = expectObject(input, "Plugin capability grant");
  assertAllowedKeys(
    value,
    ["version", "pluginId", "pluginVersion", "capabilityRef", "description", "implementationRef"],
    "Plugin capability grant"
  );
  if (value.version !== SERVER_PLUGIN_CAPABILITY_GRANT_A72_VERSION) {
    throw new Error(
      `Plugin capability grant version must be ${SERVER_PLUGIN_CAPABILITY_GRANT_A72_VERSION}.`
    );
  }
  const pluginId = requireBoundedString(value["pluginId"], "Plugin capability grant pluginId", 128);
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(pluginId)) {
    throw new Error("Plugin capability grant pluginId must be a valid plugin identity.");
  }
  const pluginVersion = requireBoundedString(
    value["pluginVersion"],
    "Plugin capability grant pluginVersion",
    64
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(pluginVersion)) {
    throw new Error("Plugin capability grant pluginVersion must be a stable plugin version.");
  }
  const capabilityRef = requireBoundedString(value["capabilityRef"], "Plugin capabilityRef", 200);
  const description = requireBoundedString(
    value["description"],
    "Plugin capability description",
    1_000
  );
  const semantic = createCognitionCapabilityDescriptions({
    version: COGNITION_6G_VERSION,
    capabilities: [{ capabilityRef, description }]
  }).capabilities[0]!;
  const implementationRef = requireToken(value.implementationRef, "Plugin implementationRef");
  if (implementationRef === SERVER_MCP_READ_TEXT_IMPLEMENTATION_REF) {
    throw new Error("Plugin implementationRef must not reuse the read_text_file implementation.");
  }
  if (!implementationRef.endsWith(".v1")) {
    throw new Error("Plugin implementationRef must carry an explicit version suffix.");
  }
  if (semantic.capabilityRef === SERVER_MCP_READ_TEXT_CAPABILITY_REF) {
    throw new Error("Plugin capabilityRef conflicts with the production read_text_file reference.");
  }
  const descriptor = Object.freeze({
    version: SERVER_MCP_CAPABILITY_DESCRIPTOR_A71_VERSION,
    capabilityRef: semantic.capabilityRef,
    description: semantic.description,
    implementationRef,
    effectContract: SERVER_PLUGIN_LOCAL_TRANSFORM_EFFECT_CONTRACT
  });
  const grant = Object.freeze({
    version: SERVER_PLUGIN_CAPABILITY_GRANT_A72_VERSION,
    pluginId,
    pluginVersion,
    descriptor
  });
  issuedPluginCapabilityGrants.add(grant);
  return grant;
}

export function assertServerPluginCapabilityGrant(
  input: unknown
): asserts input is ServerPluginCapabilityGrant {
  if (
    typeof input !== "object" ||
    input === null ||
    !issuedPluginCapabilityGrants.has(input) ||
    (input as { version?: unknown }).version !== SERVER_PLUGIN_CAPABILITY_GRANT_A72_VERSION
  ) {
    throw new Error("Plugin capability grant was not issued by the host policy validator.");
  }
}

/** Host-authored registration data; implementations and effect contracts are not caller-set. */
export function createServerMcpReadTextRegistration(
  capabilityRef: string,
  description: string
): Readonly<{
  descriptorVersion: typeof SERVER_MCP_CAPABILITY_DESCRIPTOR_A71_VERSION;
  capabilityRef: string;
  description: string;
  implementationRef: typeof SERVER_MCP_READ_TEXT_IMPLEMENTATION_REF;
}> {
  return Object.freeze({
    descriptorVersion: SERVER_MCP_CAPABILITY_DESCRIPTOR_A71_VERSION,
    capabilityRef,
    description,
    implementationRef: SERVER_MCP_READ_TEXT_IMPLEMENTATION_REF
  });
}

/**
 * Build the host-authored executable registry. Registration data contains only
 * semantic refs and an implementation ref; permission/effect contracts are
 * fixed by the approved implementation table and cannot be assigned by a
 * model, discovery result, or plugin declaration.
 */
export function createServerMcpCapabilityBindings(input: unknown): ServerMcpCapabilityBindings {
  const value = expectObject(input, "Executable capability registry");
  assertAllowedKeys(value, ["version", "capabilities"], "Executable capability registry");
  if (value.version !== SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION) {
    throw new Error(
      `Executable capability registry version must be ${SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION}.`
    );
  }
  if (!Array.isArray(value.capabilities)) {
    throw new Error("Executable capability registrations must be an array.");
  }

  const semanticCapabilities: Array<{ capabilityRef: string; description: string }> = [];
  const descriptors: ServerMcpCapabilityDescriptor[] = [];
  const bindings: ServerMcpCapabilityBinding[] = [];
  const capabilityRefs = new Set<string>();
  const implementationRefs = new Set<string>();

  for (const [index, entry] of Array.from(value.capabilities).entries()) {
    const field = `Executable capability descriptor ${index}`;
    const capability = expectObject(entry, field);
    assertAllowedKeys(
      capability,
      ["descriptorVersion", "capabilityRef", "description", "implementationRef"],
      field
    );
    if (capability.descriptorVersion !== SERVER_MCP_CAPABILITY_DESCRIPTOR_A71_VERSION) {
      throw new Error(`${field} version must be ${SERVER_MCP_CAPABILITY_DESCRIPTOR_A71_VERSION}.`);
    }

    const capabilityRef = requireBoundedString(
      capability.capabilityRef,
      `${field} capabilityRef`,
      200
    );
    const description = requireBoundedString(capability.description, `${field} description`, 2_000);
    const implementationRef = requireToken(
      capability.implementationRef,
      `${field} implementationRef`
    );
    const implementation = APPROVED_IMPLEMENTATIONS.get(implementationRef);
    if (implementation === undefined) {
      throw new Error(`${field} references an unknown executable implementation.`);
    }
    if (capabilityRefs.has(capabilityRef)) {
      throw new Error(`Executable capability reference must be unique: ${capabilityRef}.`);
    }
    if (implementationRefs.has(implementationRef)) {
      throw new Error(`Executable implementation reference must be unique: ${implementationRef}.`);
    }
    capabilityRefs.add(capabilityRef);
    implementationRefs.add(implementationRef);

    semanticCapabilities.push({ capabilityRef, description });
    descriptors.push(
      Object.freeze({
        version: SERVER_MCP_CAPABILITY_DESCRIPTOR_A71_VERSION,
        capabilityRef,
        description,
        implementationRef,
        effectContract: implementation.effectContract
      })
    );
    bindings.push(
      Object.freeze({ capabilityRef, implementationRef, toolName: implementation.toolName })
    );
  }

  const descriptions = createCognitionCapabilityDescriptions({
    version: COGNITION_6G_VERSION,
    capabilities: semanticCapabilities
  });
  const registry: ServerMcpCapabilityBindings = Object.freeze({
    version: SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION,
    descriptors: Object.freeze(descriptors),
    descriptions,
    bindings: Object.freeze(bindings)
  });
  issuedRegistries.add(registry);
  return registry;
}

/**
 * Intersect the explicit executable registry with currently discovered MCP
 * tools. Discovery may remove availability; it cannot add implementations or
 * change descriptions, permissions, effects, or routing.
 */
export function createCurrentServerMcpCapabilityBindings(
  staticRegistry: ServerMcpCapabilityBindings,
  discoveredTools: readonly ServerMcpTool[]
): ServerMcpCapabilityBindings {
  assertIssuedRegistry(staticRegistry);
  const discoveredNames = new Set(discoveredTools.map((tool) => tool.name));
  const registrations = staticRegistry.descriptors.flatMap((descriptor) => {
    const implementation = APPROVED_IMPLEMENTATIONS.get(descriptor.implementationRef);
    if (implementation === undefined || !discoveredNames.has(implementation.toolName)) {
      return [];
    }
    return [
      {
        descriptorVersion: descriptor.version,
        capabilityRef: descriptor.capabilityRef,
        description: descriptor.description,
        implementationRef: descriptor.implementationRef
      }
    ];
  });

  return createServerMcpCapabilityBindings({
    version: SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION,
    capabilities: registrations
  });
}

/** Bind one Cognition proposal to a validated static implementation reference. */
export function bindServerMcpCapabilityRequest(
  input: unknown,
  registry: ServerMcpCapabilityBindings
): ServerMcpBoundCapabilityRequest {
  assertIssuedRegistry(registry);
  const request: CognitionCapabilityRequest = createCognitionCapabilityRequest(
    input,
    registry.descriptions
  );
  const binding = registry.bindings.find(
    (candidate) => candidate.capabilityRef === request.capabilityRef
  );
  if (binding === undefined) {
    throw new Error("Server MCP capability request has no explicit binding.");
  }

  return Object.freeze({
    version: SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION,
    implementationRef: binding.implementationRef,
    toolName: binding.toolName,
    request: request.request
  });
}

function validateIdempotency(input: unknown): ServerMcpCapabilityEffectContract["idempotency"] {
  const value = expectObject(input, "Capability effect contract idempotency");
  const kind = expectEnum(
    value.kind,
    ["NONE", "UNKNOWN", "UNSUPPORTED", "ADAPTER_CERTIFIED_KEY"],
    "Capability effect contract idempotency kind"
  );
  if (kind !== "ADAPTER_CERTIFIED_KEY") {
    assertAllowedKeys(value, ["kind"], "Capability effect contract idempotency");
    return Object.freeze({ kind });
  }
  assertAllowedKeys(
    value,
    ["kind", "contractVersion", "namespace", "payloadEquality", "retentionMs"],
    "Capability effect contract idempotency"
  );
  if (value.payloadEquality !== "EXACT_CANONICAL_PAYLOAD") {
    throw new Error("Capability effect contract idempotency payloadEquality is unsupported.");
  }
  if (
    typeof value.retentionMs !== "number" ||
    !Number.isSafeInteger(value.retentionMs) ||
    value.retentionMs <= 0
  ) {
    throw new Error("Capability effect contract idempotency retentionMs must be positive.");
  }
  return Object.freeze({
    kind,
    contractVersion: requireToken(value.contractVersion, "idempotency contractVersion"),
    namespace: requireToken(value.namespace, "idempotency namespace"),
    payloadEquality: "EXACT_CANONICAL_PAYLOAD",
    retentionMs: value.retentionMs
  });
}

function validateReconciliation(
  input: unknown
): ServerMcpCapabilityEffectContract["reconciliation"] {
  const value = expectObject(input, "Capability effect contract reconciliation");
  const kind = expectEnum(
    value.kind,
    ["UNSUPPORTED", "UNKNOWN", "VERSIONED_LOOKUP"],
    "Capability effect contract reconciliation kind"
  );
  if (kind !== "VERSIONED_LOOKUP") {
    assertAllowedKeys(value, ["kind"], "Capability effect contract reconciliation");
    return Object.freeze({ kind });
  }
  assertAllowedKeys(
    value,
    ["kind", "contractVersion", "establishes"],
    "Capability effect contract reconciliation"
  );
  if (!Array.isArray(value.establishes) || value.establishes.length === 0) {
    throw new Error("Capability effect contract reconciliation establishes must be non-empty.");
  }
  const establishes = value.establishes.map((entry, index) =>
    requireToken(entry, `reconciliation establishes[${index}]`)
  );
  if (new Set(establishes).size !== establishes.length) {
    throw new Error("Capability effect contract reconciliation evidence must be unique.");
  }
  return Object.freeze({
    kind,
    contractVersion: requireToken(value.contractVersion, "reconciliation contractVersion"),
    establishes: Object.freeze(establishes)
  });
}

function requireBoundedString(input: unknown, field: string, maxLength: number): string {
  if (typeof input !== "string" || input.trim().length === 0 || input.trim() !== input) {
    throw new Error(`${field} must be a non-empty string without surrounding whitespace.`);
  }
  const value = input;
  if (value.length > maxLength) {
    throw new Error(`${field} must not exceed ${maxLength} characters.`);
  }
  return value;
}

function requireToken(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.trim() !== input ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(input)
  ) {
    throw new Error(`${field} must be a non-empty stable token.`);
  }
  return input;
}

function expectEnum<const T extends readonly string[]>(
  input: unknown,
  values: T,
  field: string
): T[number] {
  if (typeof input !== "string" || !values.includes(input)) {
    throw new Error(`${field} has unsupported semantics.`);
  }
  return input as T[number];
}

function expectObject(input: unknown, field: string): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${field} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} must be a plain data object.`);
  }
  if (
    Object.values(Object.getOwnPropertyDescriptors(input)).some(
      (descriptor) => !("value" in descriptor)
    )
  ) {
    throw new Error(`${field} must not contain accessors.`);
  }
  return input as UnknownObject;
}

function assertIssuedRegistry(registry: ServerMcpCapabilityBindings): void {
  if (
    typeof registry !== "object" ||
    registry === null ||
    !issuedRegistries.has(registry) ||
    registry.version !== SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION
  ) {
    throw new Error(
      "Server MCP capability registry was not created by the host registry validator."
    );
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${field} contains unknown field: ${unknown.sort().join(", ")}.`);
  }
}
