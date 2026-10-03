import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalControllerEvidenceProvider } from "./local-controller-evidence.js";
import {
  admitVoiceProfilePersonBinding,
  voiceProfileBindingWriteFields
} from "../voice-profile-binding.js";
import { buildMemoryScope } from "../scope.js";
import { MemoryService } from "../service.js";
import { InMemoryMemoryRepository } from "../repository.js";
import type { MemoryWriteEventInput } from "../provider.js";
import type { ControllerBindingCommand, NativeControllerBindingOwner } from "./local-controller-evidence.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "yuvi-controller-evidence-"));
  roots.push(root);
  return {
    root,
    provider: new LocalControllerEvidenceProvider(root),
    scope: buildMemoryScope("voice-profile:voice-a", "persona")
  };
}
function binding(scope: string, personId = "person-a") {
  const admitted = admitVoiceProfilePersonBinding({
    voiceProfileId: "voice-a",
    personId,
    assertor: { entityId: "local-explicit-controller", resolution: "resolved" },
    trustedController: true,
    provenanceClass: "EXTERNAL_CLAIM"
  });
  if (admitted.decision !== "admit") throw new Error();
  return { ...voiceProfileBindingWriteFields(admitted), scope };
}
function command(overrides: Partial<ControllerBindingCommand> = {}): ControllerBindingCommand {
  return {
    commandHandle: "bind-1",
    intentId: "intent-1",
    attemptId: "attempt-1",
    fence: "1",
    payloadDigest: "a".repeat(64),
    causalRefs: [{ kind: "JOURNAL_EVENT", namespace: "yuvi:default", eventId: "event-1" }],
    operation: "ASSIGN",
    voiceProfileId: "voice-a",
    personaId: "persona",
    personId: "person-a",
    expectedBindingRevision: null,
    ...overrides
  };
}
async function applyCommand(provider: NativeControllerBindingOwner, requested = command()) {
  const fenced = await provider.fenceBindingCommand(requested);
  if (fenced !== "READY") throw new Error(`unexpected native command fence: ${fenced}`);
  const result = await provider.applyBindingCommand(requested);
  if (result.status !== "APPLIED") throw new Error(`unexpected native command result: ${result.status}`);
  return result;
}
function seedLegacyRecords(root: string, inputs: MemoryWriteEventInput[]) {
  const directory = join(root, "controller-evidence");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const records = inputs.map((input) => ({ id: randomUUID(), recordedAt: "2026-01-01T00:00:00.000Z", input }));
  const sha256 = createHash("sha256").update(JSON.stringify(records)).digest("hex");
  writeFileSync(join(directory, "events.json"), JSON.stringify({ version: 1, records, sha256 }), { mode: 0o600 });
  return records.map((row) => `local-controller-evidence:${row.id}`);
}
describe("local explicit-controller binding evidence", () => {
  it("keeps binding authority stable across Mem0 backend changes", async () => {
    const { provider } = fixture();
    const local = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      undefined,
      { controllerEvidence: provider }
    );
    expect(local.getVoiceBindingProvider()).toBe(provider);
    expect(local.getMemoryProvider()).toBeUndefined();
    await applyCommand(local.getNativeVoiceBindingOwner()!);
    const external = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      undefined,
      { kind: "mem0", mem0: { kind: "mem0" } as never, controllerEvidence: provider }
    );
    expect(external.getVoiceBindingProvider()).toBe(provider);
    expect(external.getMemoryProvider()).not.toBe(provider);
  });
  it("reads the same durable binding after enabling and disabling Mem0", async () => {
    const { root, scope } = fixture();
    const service = (enabled: boolean) =>
      new MemoryService(
        new InMemoryMemoryRepository(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          kind: enabled ? "mem0" : "legacy",
          mem0: enabled ? ({ kind: "mem0" } as never) : undefined,
          controllerEvidence: new LocalControllerEvidenceProvider(root)
        }
      );
    await applyCommand(service(false).getNativeVoiceBindingOwner()!);
    for (const enabled of [true, false, true]) {
      const current = service(enabled);
      const state = await current.getNativeVoiceBindingOwner()!.getBindingState("voice-a", "persona");
      expect(state).toMatchObject({ status: "ACTIVE", personId: "person-a", lineageStatus: "VERSIONED" });
      expect(await current.getVoiceBindingProvider()!.getEvent({ id: state.eventIds[0]!, scope }))
        .toMatchObject({ id: state.eventIds[0], claim: { subject: { entityId: "person-a" } } });
    }
  });
  it("survives reconstruction with durable IDs, private files and isolated scopes", async () => {
    const { root, provider, scope } = fixture();
    const result = await applyCommand(provider);
    const eventId = result.state.eventIds[0]!;
    const restarted = new LocalControllerEvidenceProvider(root);
    expect(await restarted.getEvent({ id: eventId, scope })).toMatchObject({
      id: eventId,
      claim: { subject: { entityId: "person-a" } }
    });
    expect(
      await restarted.getEvent({
        id: eventId,
        scope: buildMemoryScope("voice-profile:voice-a", "other")
      })
    ).toBeNull();
    expect(statSync(join(root, "controller-evidence")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "controller-evidence/events.json")).mode & 0o777).toBe(0o600);
  });
  it("rejects general memory and forged ambient/assistant binding claims", async () => {
    const { provider, scope } = fixture();
    expect(await provider.writeEvent({ kind: "fact", content: "general memory", scope })).toMatchObject({
      status: "rejected", errorCode: "GOVERNED_CONTROLLER_COMMAND_REQUIRED", failureClass: "definitive_rejection"
    });
    const input = binding(scope);
    input.claim!.assertor.entityId = "ambient";
    expect((await provider.writeEvent(input)).status).toBe("rejected");
    expect(await provider.retrieveRelevant()).toMatchObject({ status: "unavailable", events: [] });
    expect("writeEventIdempotent" in provider).toBe(false);
  });
  it("does not let a missing correction reference revive a removed binding", async () => {
    const { root, provider, scope } = fixture();
    const assigned = await applyCommand(provider);
    const eventId = assigned.state.eventIds[0]!;
    const { personId: _personId, ...removeBase } = command();
    const removed = await applyCommand(provider, {
      ...removeBase,
      commandHandle: "remove-1", intentId: "intent-remove", attemptId: "attempt-remove",
      payloadDigest: "c".repeat(64), operation: "REMOVE",
      expectedBindingRevision: assigned.state.revision
    });
    expect(removed.state).toMatchObject({ status: "UNBOUND", personId: null });
    expect(
      await new LocalControllerEvidenceProvider(root).getEvent({ id: eventId, scope })
    ).toMatchObject({ metadata: { yuviMemoryStatus: "superseded" } });
    expect(
      (
        await provider.writeEvent({
          kind: "correction",
          content: "Local controller removed this voice binding.",
          scope,
          metadata: { yuviClaimSupersedes: ["missing"] }
        })
      ).status
    ).toBe("rejected");
  });
  it("fails closed on conflicting assignments even when the index omits one", async () => {
    const { root, provider, scope } = fixture();
    const [first, second] = seedLegacyRecords(root, [binding(scope), binding(scope, "person-b")]);
    expect(await provider.getEvent({ id: first!, scope })).toBeNull();
    expect(await provider.getEvent({ id: second!, scope })).toBeNull();
    expect(await provider.getBindingState("voice-a", "persona")).toMatchObject({
      status: "CONFLICT", lineageStatus: "CONFLICT", revision: null
    });
    expect(await provider.writeEvent(binding(scope, "person-b"))).toMatchObject({
      status: "rejected", errorCode: "GOVERNED_CONTROLLER_COMMAND_REQUIRED"
    });
  });
  it("rejects reads and further writes on corruption, preserving the damaged evidence", async () => {
    const { root, provider, scope } = fixture();
    const result = await applyCommand(provider);
    const eventId = result.state.eventIds[0]!;
    const file = join(root, "controller-evidence/events.json");
    const damaged = readFileSync(file, "utf8").replaceAll("person-a", "person-b");
    writeFileSync(file, damaged);
    await expect(provider.getEvent({ id: eventId, scope })).rejects.toThrow();
    expect((await provider.writeEvent(binding(scope))).status).toBe("rejected");
    expect(readFileSync(file, "utf8")).toBe(damaged);
  });
  it("commits binding revision and exact A9 command receipt with the owner generation", async () => {
    const { root, provider, scope } = fixture();
    const requested = command();
    expect(await provider.fenceBindingCommand(requested)).toBe("READY");
    const applied = await provider.applyBindingCommand(requested);
    expect(applied.status).toBe("APPLIED");
    if (applied.status !== "APPLIED") throw new Error("binding was not applied");
    expect(applied.receipt).toMatchObject({
      commandHandle: requested.commandHandle,
      intentId: requested.intentId,
      attemptId: requested.attemptId,
      fence: requested.fence,
      payloadDigest: requested.payloadDigest,
      causalRefs: requested.causalRefs,
      priorRevisionByScope: { [scope]: null },
      resultingRevisionByScope: { [scope]: applied.state.revision }
    });
    expect(applied.state).toMatchObject({
      status: "ACTIVE", personId: "person-a", lineageStatus: "VERSIONED"
    });
    expect(JSON.parse(readFileSync(join(root, "controller-evidence/events.json"), "utf8"))).toMatchObject({
      version: 2,
      commandReceipts: [expect.objectContaining({ commandHandle: requested.commandHandle })]
    });
    expect(await new LocalControllerEvidenceProvider(root).getBindingState("voice-a", "persona"))
      .toMatchObject({ status: "ACTIVE", personId: "person-a", revision: applied.state.revision });
    expect((await provider.writeEvent(binding(buildMemoryScope("voice-profile:voice-a", "persona")))).status)
      .toBe("rejected");
    const recovery = { ...requested, fence: "2" };
    expect(await provider.fenceBindingCommand(recovery)).toBe("APPLIED");
    expect((await provider.reconcileBindingCommand(recovery)).status).toBe("ALREADY_APPLIED");
  });
  it("rebuilds state without the index and governs replacement/removal with compare-and-set revisions", async () => {
    const { root, provider } = fixture();
    const first = command();
    await provider.fenceBindingCommand(first);
    const assigned = await provider.applyBindingCommand(first);
    if (assigned.status !== "APPLIED") throw new Error("assignment failed");
    const beforeReplace = await new LocalControllerEvidenceProvider(root).getBindingState("voice-a", "persona");
    const replace = command({
      commandHandle: "bind-2", attemptId: "attempt-2", fence: "1", operation: "REPLACE",
      personId: "person-b", expectedBindingRevision: beforeReplace.revision
    });
    expect(await provider.fenceBindingCommand(replace)).toBe("READY");
    const replaced = await provider.applyBindingCommand(replace);
    expect(replaced).toMatchObject({ status: "APPLIED", state: { personId: "person-b", lineageStatus: "VERSIONED" } });
    if (replaced.status !== "APPLIED") throw new Error("replacement failed");
    expect(await provider.getEvent({ id: assigned.state.eventIds[0]!, scope: buildMemoryScope("voice-profile:voice-a", "persona") }))
      .toMatchObject({ metadata: { yuviMemoryStatus: "superseded" } });
    const { personId: _personId, ...removeBase } = command();
    const remove: ControllerBindingCommand = {
      ...removeBase, commandHandle: "bind-3", attemptId: "attempt-3", fence: "1", operation: "REMOVE",
      expectedBindingRevision: replaced.state.revision
    };
    expect(await provider.fenceBindingCommand(remove)).toBe("READY");
    expect(await provider.applyBindingCommand(remove)).toMatchObject({
      status: "APPLIED", state: { status: "UNBOUND", personId: null, lineageStatus: "VERSIONED" }
    });
    expect(await provider.listBindingStates()).toMatchObject({ complete: true, bindings: [ { status: "UNBOUND" } ] });
  });
  it("switches a profile across persona scopes in one native owner generation", async () => {
    const { provider } = fixture();
    const assigned = await applyCommand(provider);
    const priorScope = buildMemoryScope("voice-profile:voice-a", "persona");
    const targetScope = buildMemoryScope("voice-profile:voice-a", "persona-b");
    const switchScope: ControllerBindingCommand = {
      ...command({
        commandHandle: "switch-persona",
        attemptId: "switch-persona-attempt",
        operation: "REPLACE",
        personaId: "persona-b",
        personId: "person-b",
        expectedBindingRevision: null,
        previousVoiceProfileId: "voice-a",
        previousPersonaId: "persona",
        expectedPreviousBindingRevision: assigned.state.revision
      })
    };
    expect(await provider.fenceBindingCommand(switchScope)).toBe("READY");
    const switched = await provider.applyBindingCommand(switchScope);
    expect(switched).toMatchObject({
      status: "APPLIED",
      state: { status: "ACTIVE", personaId: "persona-b", personId: "person-b" },
      receipt: {
        previousPersonaId: "persona",
        priorRevisionByScope: { [priorScope]: assigned.state.revision, [targetScope]: null },
        resultingRevisionByScope: { [priorScope]: expect.any(String), [targetScope]: expect.any(String) }
      }
    });
    expect(await provider.getBindingState("voice-a", "persona"))
      .toMatchObject({ status: "UNBOUND", revision: expect.any(String), eventIds: [] });
    expect(await provider.getBindingState("voice-a", "persona-b"))
      .toMatchObject({ status: "ACTIVE", personId: "person-b", revision: switched.status === "APPLIED" ? switched.state.revision : undefined });
    expect(switched.status === "APPLIED" && switched.receipt.eventIds).toHaveLength(2);
    expect(await provider.applyBindingCommand(switchScope)).toMatchObject({ status: "ALREADY_APPLIED" });
  });
  it("fences a recovered attempt before proving the exact predecessor remains", async () => {
    const { provider } = fixture();
    const requested = command();
    expect(await provider.fenceBindingCommand(requested)).toBe("READY");
    const recovered = command({ fence: "2" });
    const result = await provider.reconcileBindingCommand(recovered);
    expect(result).toMatchObject({ status: "PROVEN_NOT_APPLIED" });
    expect(await provider.applyBindingCommand(requested)).toMatchObject({ status: "UNKNOWN" });
  });
  it("allows only one concurrent command against a binding revision", async () => {
    const { provider } = fixture();
    const first = command();
    await provider.fenceBindingCommand(first);
    const assigned = await provider.applyBindingCommand(first);
    if (assigned.status !== "APPLIED") throw new Error("assignment failed");
    const expected = assigned.state.revision;
    const a = command({ commandHandle: "replace-a", attemptId: "attempt-a", operation: "REPLACE", personId: "person-b", expectedBindingRevision: expected });
    const b = command({ commandHandle: "replace-b", attemptId: "attempt-b", operation: "REPLACE", personId: "person-c", expectedBindingRevision: expected });
    await Promise.all([provider.fenceBindingCommand(a), provider.fenceBindingCommand(b)]);
    const outcomes = await Promise.all([provider.applyBindingCommand(a), provider.applyBindingCommand(b)]);
    expect(outcomes.filter((outcome) => outcome.status === "APPLIED")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "CONFLICT")).toHaveLength(1);
  });
});
