import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { MEMORY_CLAIM_METADATA as M, currentEligibleMemoryEvents } from "../claim.js";
import { buildMemoryScope, parseMemoryScope } from "../scope.js";
import {
  admitVoiceProfilePersonBinding,
  voiceProfileBindingWriteFields
} from "../voice-profile-binding.js";
import type {
  MemoryEvent,
  MemoryProvider,
  MemoryWriteEventInput,
  MemoryWriteEventOutcome
} from "../provider.js";

const source = "local-controller-evidence";
const record = z
  .object({
    id: z.string().uuid(),
    recordedAt: z.string().datetime(),
    input: z.record(z.unknown())
  })
  .strict();
const envelope = z
  .object({
    version: z.literal(1),
    records: z.array(record),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
const controllerCausalRef = z.object({
  kind: z.literal("JOURNAL_EVENT"),
  namespace: z.string().min(1).max(512),
  eventId: z.string().min(1).max(512)
}).strict();
const commandReceipt = z.object({
  version: z.literal("controller-binding-application.v1"),
  commandHandle: z.string().min(1).max(256),
  intentId: z.string().min(1).max(512),
  attemptId: z.string().min(1).max(512),
  fence: z.string().regex(/^[1-9][0-9]*$/),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  causalRefs: z.array(controllerCausalRef).min(1).max(8),
  scope: z.string().min(1).max(1024),
  voiceProfileId: z.string().min(1).max(160),
  previousVoiceProfileId: z.string().min(1).max(160).nullable(),
  previousPersonaId: z.string().min(1).max(100).nullable().optional(),
  operation: z.enum(["ASSIGN", "REPLACE", "REMOVE"]),
  personId: z.string().min(1).max(512).nullable(),
  eventIds: z.array(z.string().min(1).max(512)).min(1).max(2),
  priorRevisionByScope: z.record(z.string().max(512).nullable()),
  resultingRevisionByScope: z.record(z.string().min(1).max(512))
}).strict();
const commandFence = z.object({
  intentId: z.string().min(1).max(512),
  attemptId: z.string().min(1).max(512),
  fence: z.string().regex(/^[1-9][0-9]*$/),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type ControllerBindingCommandReceipt = z.infer<typeof commandReceipt>;
const envelopeV2 = z.object({
  version: z.literal(2),
  revision: z.string().min(1).max(512),
  bindingRevisionByScope: z.record(z.string().min(1).max(512)),
  commandReceipts: z.array(commandReceipt),
  commandFences: z.record(commandFence),
  records: z.array(record),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const persistedEnvelope = z.union([envelope, envelopeV2]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type PersistedV2 = z.infer<typeof envelopeV2>;
type OwnerSnapshot = {
  records: z.infer<typeof record>[];
  events: MemoryEvent[];
  v2: PersistedV2 | null;
};

export type ControllerBindingCommand = Readonly<{
  commandHandle: string;
  intentId: string;
  attemptId: string;
  fence: string;
  payloadDigest: string;
  causalRefs: readonly { kind: "JOURNAL_EVENT"; namespace: string; eventId: string }[];
  operation: "ASSIGN" | "REPLACE" | "REMOVE";
  voiceProfileId: string;
  previousVoiceProfileId?: string;
  previousPersonaId?: string;
  personaId: string;
  personId?: string;
  expectedBindingRevision: string | null;
  expectedPreviousBindingRevision?: string | null;
}>;
export type ControllerBindingState = Readonly<{
  status: "ACTIVE" | "UNBOUND" | "CONFLICT";
  voiceProfileId: string;
  personaId: string;
  personId: string | null;
  revision: string | null;
  lineageStatus: "VERSIONED" | "LEGACY_UNLINEAGED" | "UNBOUND" | "CONFLICT";
  eventIds: readonly string[];
}>;
export type ControllerBindingCommandResult =
  | { status: "APPLIED" | "ALREADY_APPLIED"; state: ControllerBindingState; receipt: ControllerBindingCommandReceipt }
  | { status: "PROVEN_NOT_APPLIED"; reason: "EXACT_PREDECESSOR_REMAINS" | "ASSIGNMENT_EXISTS" | "BINDING_ABSENT" | "PERSON_TARGET_MISMATCH" }
  | { status: "UNKNOWN" | "CONFLICT" };

export type ControllerBindingCommandFence = Readonly<{
  commandHandle: string;
  intentId: string;
  attemptId: string;
  fence: string;
  payloadDigest: string;
  causalRefs: readonly { kind: "JOURNAL_EVENT"; namespace: string; eventId: string }[];
}>;

export interface NativeControllerBindingOwner extends MemoryProvider {
  getBindingState(voiceProfileId: string, personaId: string): Promise<ControllerBindingState>;
  listBindingStates(): Promise<{ complete: true; ownerRevision: string | null; bindings: readonly ControllerBindingState[] }>;
  fenceBindingCommand(command: ControllerBindingCommandFence): Promise<"READY" | "APPLIED" | "UNKNOWN" | "CONFLICT">;
  applyBindingCommand(command: ControllerBindingCommand): Promise<ControllerBindingCommandResult>;
  reconcileBindingCommand(command: ControllerBindingCommand): Promise<ControllerBindingCommandResult>;
}

/** A narrow explicit-controller evidence adapter. No retrieval, extraction, or general writes. */
export class LocalControllerEvidenceProvider implements NativeControllerBindingOwner {
  private readonly directory: string;
  private readonly file: string;
  constructor(dataRoot: string) {
    if (!isAbsolute(dataRoot))
      throw new Error("Controller evidence requires an absolute DATA root.");
    this.directory = join(dataRoot, "controller-evidence");
    this.file = join(this.directory, "events.json");
  }
  async retrieveRelevant() {
    return {
      status: "unavailable" as const,
      events: [],
      source,
      limited: false,
      errorCode: "LOCAL_EVIDENCE_HAS_NO_SEARCH"
    };
  }
  private lockDirectory() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("Evidence directory must be private.");
    const lock = join(this.directory, "write.lock");
    mkdirSync(lock, { mode: 0o700 });
    return lock;
  }
  private readEnvelope(): OwnerSnapshot {
    let fd: number;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { records: [], events: [], v2: null };
      throw error;
    }
    let parsed: z.infer<typeof persistedEnvelope>;
    try {
      const directory = lstatSync(this.directory), file = fstatSync(fd);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 ||
          !file.isFile() || file.mode & 0o077)
        throw new Error("Controller evidence must remain private.");
      parsed = persistedEnvelope.parse(JSON.parse(readFileSync(fd, "utf8")));
    } finally {
      closeSync(fd);
    }
    if (parsed.version === 1) {
      if (digest(parsed.records) !== parsed.sha256)
        throw new Error("Controller evidence checksum mismatch.");
    } else {
      const { sha256, ...body } = parsed;
      if (digest(body) !== sha256) throw new Error("Controller evidence checksum mismatch.");
    }
    const events: MemoryEvent[] = [];
    for (const row of parsed.records) {
      if (events.some((event) => event.sourceRecordId === row.id))
        throw new Error("Duplicate evidence ID.");
      const input = this.normalize(row.input as MemoryWriteEventInput, events);
      if (digest(input) !== digest(row.input))
        throw new Error("Invalid controller evidence record.");
      events.push({
        ...input,
        id: `${source}:${row.id}`,
        source,
        sourceRecordId: row.id,
        recordedAt: row.recordedAt,
        metadata: input.metadata ?? {}
      });
    }
    return { records: parsed.records, events, v2: parsed.version === 2 ? parsed : null };
  }
  private writeEnvelope(snapshot: OwnerSnapshot, updates: Partial<Omit<PersistedV2, "version" | "sha256" | "records">> & { records?: z.infer<typeof record>[] }) {
    const previous = snapshot.v2;
    const body = {
      version: 2 as const,
      revision: updates.revision ?? previous?.revision ?? `owner_${randomUUID()}`,
      bindingRevisionByScope: updates.bindingRevisionByScope ?? previous?.bindingRevisionByScope ?? {},
      commandReceipts: updates.commandReceipts ?? previous?.commandReceipts ?? [],
      commandFences: updates.commandFences ?? previous?.commandFences ?? {},
      records: updates.records ?? snapshot.records
    };
    const next: PersistedV2 = { ...body, sha256: digest(body) };
    const id = randomUUID();
    const temporary = join(this.directory, `${id}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify(next));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.file);
    const dir = openSync(this.directory, constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return next;
  }
  private normalize(input: MemoryWriteEventInput, previous: MemoryEvent[]): MemoryWriteEventInput {
    const scope = parseMemoryScope(input.scope);
    if (!scope.userId.startsWith("voice-profile:") || !scope.characterId.trim())
      throw new Error("Unsupported evidence scope.");
    const supersedes = input.metadata?.[M.supersedes];
    if (
      supersedes !== undefined &&
      (!Array.isArray(supersedes) ||
        !supersedes.length ||
        supersedes.some(
          (id) =>
            typeof id !== "string" || !previous.some((e) => e.id === id && e.scope === input.scope)
        ))
    )
      throw new Error("Invalid correction references.");
    if (
      input.kind === "correction" &&
      !input.claim &&
      Array.isArray(supersedes) &&
      input.content === "Local controller removed this voice binding."
    ) {
      return {
        kind: "correction",
        content: input.content,
        scope: input.scope,
        metadata: { [M.supersedes]: [...supersedes] }
      };
    }
    const claim = input.claim;
    if (
      (input.kind !== "user_claim" && input.kind !== "correction") ||
      claim?.assertor.entityId !== "local-explicit-controller" ||
      claim.assertor.resolution !== "resolved" ||
      claim.provenanceClass !== "EXTERNAL_CLAIM" ||
      claim.subject.resolution !== "resolved" ||
      !claim.subject.entityId
    )
      throw new Error("Only explicit controller bindings are supported.");
    const voiceProfileId = scope.userId.slice("voice-profile:".length);
    if (
      input.metadata?.["yuviVoiceProfileId"] !== voiceProfileId ||
      input.metadata?.["yuviVoiceProfileBinding"] !== "assignment"
    )
      throw new Error("Invalid binding metadata.");
    const admitted = admitVoiceProfilePersonBinding({
      voiceProfileId,
      personId: claim.subject.entityId,
      assertor: claim.assertor,
      provenanceClass: claim.provenanceClass,
      trustedController: true,
      content: input.content
    });
    if (admitted.decision !== "admit") throw new Error("Invalid binding evidence.");
    if (input.kind === "correction" && !supersedes)
      throw new Error("Correction requires supersession.");
    const fields = voiceProfileBindingWriteFields(admitted);
    return {
      ...fields,
      kind: input.kind,
      scope: input.scope,
      metadata: { ...fields.metadata, ...(supersedes ? { [M.supersedes]: supersedes } : {}) }
    };
  }
  private read() { return this.readEnvelope(); }
  private bindingState(snapshot: OwnerSnapshot, voiceProfileId: string, personaId: string): ControllerBindingState {
    const scope = buildMemoryScope(`voice-profile:${voiceProfileId}`, personaId);
    const scoped = snapshot.events.filter((event) => event.scope === scope);
    const eligible = currentEligibleMemoryEvents(scoped);
    const people = new Set(eligible.filter((event) => event.claim).map((event) => event.claim!.subject.entityId));
    if (people.size > 1) return { status: "CONFLICT", voiceProfileId, personaId, personId: null, revision: null, lineageStatus: "CONFLICT", eventIds: eligible.map((event) => event.id) };
    const personId = [...people][0] ?? null;
    const revision = snapshot.v2?.bindingRevisionByScope[scope] ?? null;
    if (!personId) return { status: "UNBOUND", voiceProfileId, personaId, personId: null, revision, lineageStatus: revision ? "VERSIONED" : "UNBOUND", eventIds: [] };
    return {
      status: "ACTIVE", voiceProfileId, personaId, personId, revision,
      lineageStatus: revision ? "VERSIONED" : "LEGACY_UNLINEAGED",
      eventIds: eligible.filter((event) => event.claim?.subject.entityId === personId).map((event) => event.id)
    };
  }
  async getBindingState(voiceProfileId: string, personaId: string): Promise<ControllerBindingState> {
    return this.bindingState(this.readEnvelope(), voiceProfileId, personaId);
  }
  async listBindingStates(): Promise<{ complete: true; ownerRevision: string | null; bindings: readonly ControllerBindingState[] }> {
    const snapshot = this.readEnvelope();
    const scopes = new Set(snapshot.events.flatMap((event) => typeof event.scope === "string" ? [event.scope] : []));
    const bindings = [...scopes].map((scope) => {
      const parsed = parseMemoryScope(scope);
      const prefix = "voice-profile:";
      if (!parsed.userId.startsWith(prefix)) return null;
      return this.bindingState(snapshot, parsed.userId.slice(prefix.length), parsed.characterId);
    }).filter((item): item is ControllerBindingState => item !== null);
    return { complete: true, ownerRevision: snapshot.v2?.revision ?? null, bindings };
  }
  async fenceBindingCommand(command: ControllerBindingCommandFence): Promise<"READY" | "APPLIED" | "UNKNOWN" | "CONFLICT"> {
    let lock: string | undefined;
    try {
      lock = this.lockDirectory();
      const snapshot = this.readEnvelope();
      const receipt = snapshot.v2?.commandReceipts.find((item) => item.commandHandle === command.commandHandle);
      if (receipt) {
        if (receipt.intentId !== command.intentId || receipt.payloadDigest !== command.payloadDigest) return "CONFLICT";
        return receipt.attemptId === command.attemptId && BigInt(receipt.fence) <= BigInt(command.fence)
          ? "APPLIED"
          : "UNKNOWN";
      }
      const fences = snapshot.v2?.commandFences ?? {};
      const previous = fences[command.commandHandle];
      if (previous) {
        if (previous.intentId !== command.intentId || previous.payloadDigest !== command.payloadDigest) return "CONFLICT";
        const priorFence = BigInt(previous.fence), nextFence = BigInt(command.fence);
        if (nextFence < priorFence) return "UNKNOWN";
        if (nextFence === priorFence && previous.attemptId !== command.attemptId) return "UNKNOWN";
      }
      const nextFences = { ...fences, [command.commandHandle]: {
        intentId: command.intentId, attemptId: command.attemptId, fence: command.fence, payloadDigest: command.payloadDigest
      } };
      this.writeEnvelope(snapshot, { revision: `owner_${randomUUID()}`, commandFences: nextFences });
      return "READY";
    } catch {
      return "UNKNOWN";
    } finally {
      if (lock) rmdirSync(lock);
    }
  }
  async applyBindingCommand(command: ControllerBindingCommand): Promise<ControllerBindingCommandResult> {
    let lock: string | undefined;
    try {
      lock = this.lockDirectory();
      const snapshot = this.readEnvelope();
      const priorReceipt = snapshot.v2?.commandReceipts.find((item) => item.commandHandle === command.commandHandle);
      if (priorReceipt) {
        const same = priorReceipt.intentId === command.intentId && priorReceipt.attemptId === command.attemptId &&
          BigInt(priorReceipt.fence) <= BigInt(command.fence) && priorReceipt.payloadDigest === command.payloadDigest;
        return same
          ? { status: "ALREADY_APPLIED", receipt: priorReceipt, state: this.bindingState(snapshot, command.voiceProfileId, command.personaId) }
          : { status: "UNKNOWN" };
      }
      const fence = snapshot.v2?.commandFences[command.commandHandle];
      if (!fence || fence.intentId !== command.intentId || fence.attemptId !== command.attemptId ||
          fence.fence !== command.fence || fence.payloadDigest !== command.payloadDigest)
        return { status: "UNKNOWN" };
      const scope = buildMemoryScope(`voice-profile:${command.voiceProfileId}`, command.personaId);
      const state = this.bindingState(snapshot, command.voiceProfileId, command.personaId);
      const previousPersonaId = command.previousPersonaId ?? command.personaId;
      const previousScope = command.previousVoiceProfileId
        ? buildMemoryScope(`voice-profile:${command.previousVoiceProfileId}`, previousPersonaId)
        : null;
      const previousState = command.previousVoiceProfileId
        ? this.bindingState(snapshot, command.previousVoiceProfileId, previousPersonaId)
        : null;
      if (state.revision !== command.expectedBindingRevision ||
          (previousState && previousState.revision !== (command.expectedPreviousBindingRevision ?? null)))
        return { status: "CONFLICT" };
      if (state.status === "CONFLICT") return { status: "CONFLICT" };
      if (previousState?.status === "CONFLICT") return { status: "CONFLICT" };
      if (command.operation === "ASSIGN" && state.status === "ACTIVE")
        return { status: "PROVEN_NOT_APPLIED", reason: "ASSIGNMENT_EXISTS" };
      if (command.operation === "REPLACE" && command.previousVoiceProfileId) {
        const sameScope = command.previousVoiceProfileId === command.voiceProfileId && previousPersonaId === command.personaId;
        if (sameScope || !command.personId ||
            state.status !== "UNBOUND" || previousState?.status !== "ACTIVE")
          return { status: "PROVEN_NOT_APPLIED", reason: "BINDING_ABSENT" };
        if (command.previousVoiceProfileId !== command.voiceProfileId && previousState.personId !== command.personId)
          return { status: "PROVEN_NOT_APPLIED", reason: "PERSON_TARGET_MISMATCH" };
      } else if ((command.operation === "REPLACE" || command.operation === "REMOVE") && state.status !== "ACTIVE")
        return { status: "PROVEN_NOT_APPLIED", reason: "BINDING_ABSENT" };
      if (command.operation === "REPLACE" && !command.previousVoiceProfileId && state.personId === command.personId)
        return { status: "PROVEN_NOT_APPLIED", reason: "PERSON_TARGET_MISMATCH" };
      const entries: Array<{ id: string; scope: string; input: MemoryWriteEventInput }> = [];
      if (command.operation === "REMOVE") {
        entries.push({ id: randomUUID(), scope, input: {
          kind: "correction", content: "Local controller removed this voice binding.", scope,
          metadata: { [M.supersedes]: [...state.eventIds] }
        } });
      } else {
        if (!command.personId) return { status: "CONFLICT" };
        const admitted = admitVoiceProfilePersonBinding({
          voiceProfileId: command.voiceProfileId, personId: command.personId,
          assertor: { entityId: "local-explicit-controller", resolution: "resolved" },
          provenanceClass: "EXTERNAL_CLAIM", trustedController: true,
          content: `voice profile ${command.voiceProfileId} assigned to person ${command.personId}`
        });
        if (admitted.decision !== "admit") return { status: "CONFLICT" };
        const fields = voiceProfileBindingWriteFields(admitted);
        const assignment: MemoryWriteEventInput = {
          ...fields,
          kind: command.operation === "REPLACE" && !command.previousVoiceProfileId ? "correction" : "user_claim",
          scope,
          metadata: { ...fields.metadata, ...(command.operation === "REPLACE" && !command.previousVoiceProfileId ? { [M.supersedes]: [...state.eventIds] } : {}) }
        };
        entries.push({ id: randomUUID(), scope, input: assignment });
        if (previousScope && previousState && command.previousVoiceProfileId) {
          entries.push({ id: randomUUID(), scope: previousScope, input: {
            kind: "correction", content: "Local controller removed this voice binding.", scope: previousScope,
            metadata: { [M.supersedes]: [...previousState.eventIds] }
          } });
        }
      }
      const normalizedEntries = entries.map(entry => ({
        ...entry,
        input: this.normalize(entry.input, snapshot.events)
      }));
      const priorRevisionByScope: Record<string, string | null> = { [scope]: state.revision };
      const resultingRevisionByScope: Record<string, string> = { [scope]: `binding_${randomUUID()}` };
      if (previousScope && previousState && command.previousVoiceProfileId) {
        priorRevisionByScope[previousScope] = previousState.revision;
        resultingRevisionByScope[previousScope] = `binding_${randomUUID()}`;
      }
      const recordedAt = new Date().toISOString();
      const records = [...snapshot.records, ...normalizedEntries.map(entry => ({
        id: entry.id, recordedAt, input: entry.input
      }))];
      const nativeReceipt = commandReceipt.parse({
        version: "controller-binding-application.v1", commandHandle: command.commandHandle,
        intentId: command.intentId, attemptId: command.attemptId, fence: command.fence,
        payloadDigest: command.payloadDigest, causalRefs: command.causalRefs, scope,
        voiceProfileId: command.voiceProfileId, previousVoiceProfileId: command.previousVoiceProfileId ?? null,
        ...(command.previousVoiceProfileId ? { previousPersonaId } : {}),
        operation: command.operation,
        personId: command.operation === "REMOVE" ? null : command.personId,
        eventIds: normalizedEntries.map(entry => `${source}:${entry.id}`),
        priorRevisionByScope, resultingRevisionByScope
      });
      const bindingRevisionByScope = { ...(snapshot.v2?.bindingRevisionByScope ?? {}), ...resultingRevisionByScope };
      this.writeEnvelope(snapshot, {
        revision: `owner_${randomUUID()}`,
        records,
        bindingRevisionByScope,
        commandReceipts: [...(snapshot.v2?.commandReceipts ?? []), nativeReceipt]
      });
      const resultingRevision = resultingRevisionByScope[scope]!;
      return { status: "APPLIED", receipt: nativeReceipt,
        state: { status: command.operation === "REMOVE" ? "UNBOUND" : "ACTIVE", voiceProfileId: command.voiceProfileId,
          personaId: command.personaId, personId: command.operation === "REMOVE" ? null : command.personId!,
          revision: resultingRevision, lineageStatus: "VERSIONED",
          eventIds: command.operation === "REMOVE" ? [] : normalizedEntries.filter(entry => entry.scope === scope).map(entry => `${source}:${entry.id}`) } };
    } catch {
      return { status: "UNKNOWN" };
    } finally {
      if (lock) rmdirSync(lock);
    }
  }
  async reconcileBindingCommand(command: ControllerBindingCommand): Promise<ControllerBindingCommandResult> {
    const fenced = await this.fenceBindingCommand(command);
    if (fenced === "CONFLICT") return { status: "CONFLICT" };
    const snapshot = this.readEnvelope();
    const receipt = snapshot.v2?.commandReceipts.find((item) => item.commandHandle === command.commandHandle);
    if (receipt) {
      const exact = receipt.intentId === command.intentId && receipt.attemptId === command.attemptId &&
        BigInt(receipt.fence) <= BigInt(command.fence) && receipt.payloadDigest === command.payloadDigest;
      if (!exact) return { status: "UNKNOWN" };
      return { status: "ALREADY_APPLIED", receipt, state: this.bindingState(snapshot, command.voiceProfileId, command.personaId) };
    }
    if (fenced === "READY") {
      const state = this.bindingState(snapshot, command.voiceProfileId, command.personaId);
      const previous = command.previousVoiceProfileId
        ? this.bindingState(snapshot, command.previousVoiceProfileId, command.previousPersonaId ?? command.personaId)
        : null;
      if (state.revision === command.expectedBindingRevision &&
          (!previous || previous.revision === (command.expectedPreviousBindingRevision ?? null)))
        return { status: "PROVEN_NOT_APPLIED", reason: "EXACT_PREDECESSOR_REMAINS" };
    }
    return { status: "UNKNOWN" };
  }
  async getEvent({ id, scope }: { id: string; scope: string }): Promise<MemoryEvent | null> {
    const { events } = this.read();
    const event = events.find((e) => e.id === id && e.scope === scope);
    if (!event) return null;
    const scoped = events.filter((e) => e.scope === scope);
    const eligible = currentEligibleMemoryEvents(scoped);
    // An incomplete reference index cannot revive removed evidence or hide conflicting assignments.
    if (!eligible.some((e) => e.id === id))
      return { ...event, metadata: { ...event.metadata, [M.memoryStatus]: "superseded" } };
    const subjects = new Set(eligible.filter((e) => e.claim).map((e) => e.claim!.subject.entityId));
    if (event.claim && subjects.size > 1) return null;
    return event;
  }
  async writeEvent(_input: MemoryWriteEventInput): Promise<MemoryWriteEventOutcome> {
    // This compatibility provider is read-only. New assignments require a
    // committed CONTROL receipt and a fenced native A9 command.
    return {
      status: "rejected",
      errorCode: "GOVERNED_CONTROLLER_COMMAND_REQUIRED",
      failureClass: "definitive_rejection"
    };
  }
}
