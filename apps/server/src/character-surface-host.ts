import { createHash, randomUUID } from "node:crypto";
import type { RuntimeImageAttachment } from "@companion/core";
import {
  createEvent,
  RuntimeSocialContextSchema,
  type JournalEventRef,
  type RuntimeSocialContext
} from "@companion/protocol";
import type { AppContext } from "./context.js";

export type SurfacePerson = Readonly<{
  personId: string;
  displayName: string;
  bindingVersion: string;
}>;
export type SurfaceInput = Readonly<{
  channelRef: string;
  conversationKind: "PRIVATE" | "GROUP";
  actorId: string;
  displayName?: string;
  content: string;
  transportFacts: string;
  hasImage: boolean;
  // Admission admits a turn; it never decides RESPOND/SILENCE/NEED_COGNITION.
  admission?: RuntimeSocialContext["admission"];
  mentions: readonly string[];
  reply?: RuntimeSocialContext["reply"];
  observations: RuntimeSocialContext["observations"];
}>;
export type SurfaceConnection = Readonly<{
  generation: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  write(text: string, signal: AbortSignal): Promise<void>;
  readImage?: ((signal: AbortSignal) => Promise<RuntimeImageAttachment | undefined>) | undefined;
}>;
export type SurfaceResult = Readonly<{
  sourceJournalRef: JournalEventRef;
  speaker: RuntimeSocialContext["speaker"];
  outcome: "OBSERVED" | "SILENCE" | "RESPOND" | "STALE" | "UNKNOWN";
}>;
export interface CharacterSurfacePort {
  receive(input: SurfaceInput, connection: SurfaceConnection): Promise<SurfaceResult>;
}
export type CharacterSurfaceGrant = Readonly<{
  surfaceId: string;
  principalNamespace: string;
  // This is host configuration; plugin/wire fields cannot assign it.
  resolvePerson(actorId: string): SurfacePerson | null;
  acceptsChannel(channelRef: string): boolean;
}>;

/** A narrow host port reusable by QQ/Discord/Telegram/Matrix adapters. */
export class HostCharacterSurfaces {
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  constructor(
    private readonly context: Pick<
      AppContext,
      "runtime" | "surfaceReceiptAdmission" | "outwardEffects"
    >
  ) {}
  bind(grant: CharacterSurfaceGrant): CharacterSurfacePort {
    const frozen = Object.freeze({ ...grant });
    return Object.freeze({
      receive: (input: SurfaceInput, connection: SurfaceConnection) => {
        if (this.shutdown.signal.aborted || this.active.size >= 16)
          return Promise.reject(Error("Surface ingress is sealed or full."));
        const work = this.receive(frozen, structuredClone(input), connection);
        this.active.add(work);
        void work.finally(() => this.active.delete(work)).catch(() => {});
        return work;
      }
    });
  }
  close(): Promise<void> {
    this.shutdown.abort();
    return Promise.allSettled([...this.active]).then(() => {});
  }
  private async receive(
    grant: CharacterSurfaceGrant,
    input: SurfaceInput,
    connection: SurfaceConnection
  ): Promise<SurfaceResult> {
    if (!grant.acceptsChannel(input.channelRef)) throw Error("Channel is outside the host grant.");
    const signal = AbortSignal.any([this.shutdown.signal, connection.signal]);
    const current = () => !signal.aborted && connection.isCurrent();
    if (!current()) throw Error("Stale surface generation.");
    const person = grant.resolvePerson(input.actorId);
    const speaker = {
      principalId: `${grant.principalNamespace}:${input.actorId}`,
      ...(input.displayName ? { observedDisplayName: input.displayName } : {}),
      ...(person
        ? { personId: person.personId, displayName: person.displayName }
        : input.displayName
          ? { displayName: input.displayName }
          : {})
    };
    const sessionId = input.channelRef;
    const id = randomUUID();
    const sourceJournalRef = await this.context.surfaceReceiptAdmission.admit({
      namespace: grant.principalNamespace,
      actorId: input.actorId,
      channelRef: input.channelRef,
      conversationKind: input.conversationKind,
      sessionId,
      runtimeEventId: id,
      content: input.content,
      transportFacts: input.transportFacts,
      hasImage: input.hasImage,
      ...(person ? { binding: { personId: person.personId, version: person.bindingVersion } } : {})
    });
    const result = (outcome: SurfaceResult["outcome"]): SurfaceResult => ({
      sourceJournalRef,
      speaker,
      outcome
    });
    if (!current()) return result("STALE");
    if (!input.admission) return result("OBSERVED");
    const socialContext = RuntimeSocialContextSchema.parse({
      surface: grant.surfaceId,
      channelRef: input.channelRef,
      conversationKind: input.conversationKind,
      admission: input.admission,
      speaker,
      mentions: input.mentions.map((actor) => `${grant.principalNamespace}:${actor}`),
      observations: input.observations,
      ...(input.reply ? { reply: input.reply } : {})
    });
    const event = createEvent(
      "user.message",
      {
        sessionId,
        content: input.content,
        sourceJournalRef,
        // Unbound speakers deliberately have no Memory access, rather than inheriting an env-default Person.
        subjectUserId: person?.personId ?? speaker.principalId,
        speakerId: person?.personId ?? speaker.principalId
      },
      { id }
    );
    const target = {
      surface: "EXTERNAL_CHANNEL" as const,
      targetId: input.channelRef,
      targetGeneration: connection.generation
    };
    const unregister = this.context.outwardEffects.registerTarget(
      target,
      (_session, trace) => trace === event.traceId,
      current
    );
    try {
      const imageAttachment = input.hasImage ? await connection.readImage?.(signal) : undefined;
      if (input.hasImage)
        socialContext.media = { image: imageAttachment ? "ATTACHED" : "UNAVAILABLE" };
      if (!current()) return result("STALE");
      const response = await this.context.runtime.handleUserMessage(event, {
        signal,
        socialContext,
        voiceOutput: false,
        speechPlan: "NONE",
        controlAuthority: "UNTRUSTED",
        readMemory: person !== null,
        writeMemory: person !== null,
        ...(imageAttachment ? { imageAttachment } : {})
      });
      if (!current()) return result("STALE");
      if (response === null) return result("SILENCE");
      const text = response.payload.content;
      const componentId = `rc1_${createHash("sha256")
        .update(`${response.id}\0${"1"}\0${createHash("sha256").update(text).digest("hex")}`)
        .digest("hex")}`;
      try {
        await this.context.outwardEffects.publish({
          target,
          frameId: response.id,
          payload: { reply: text },
          scope: `session:${sessionId}`,
          cause: sourceJournalRef,
          replyId: response.id,
          componentId,
          acknowledgementLayer: "EXTERNAL_SERVICE_ACCEPTED",
          write: async (dispatchSignal) => {
            const sendSignal = AbortSignal.any([
              signal,
              ...(dispatchSignal ? [dispatchSignal] : [])
            ]);
            if (!current() || sendSignal.aborted) throw Error("Stale surface publication.");
            await connection.write(text, sendSignal);
          }
        });
        return result("RESPOND");
      } catch {
        // Canonical A9 owns UNKNOWN and refuses replay. No send retry belongs here.
        return result("UNKNOWN");
      }
    } finally {
      unregister();
    }
  }
}
