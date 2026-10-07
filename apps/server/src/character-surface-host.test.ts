import { describe, expect, it, vi } from "vitest";
import { HostCharacterSurfaces, type SurfaceInput } from "./character-surface-host.js";
import type { AppContext } from "./context.js";
const input: SurfaceInput = {
  channelRef: "discord:test:group",
  conversationKind: "GROUP",
  actorId: "7",
  content: "hello",
  transportFacts: "{}",
  hasImage: false,
  admission: "MENTION",
  mentions: ["alice"],
  observations: []
};
function fixture(bound = true, selfActorId?: string) {
  let receiptCount = 0;
  const handleUserMessage = vi.fn(async (_event: unknown, _options: unknown) => ({
    id: "reply",
    payload: { content: "Alice reply" }
  }));
  const admit = vi.fn(async (_input: unknown) => ({
    kind: "JOURNAL_EVENT" as const,
    namespace: "test",
    eventId: "jev1_" + String(++receiptCount).padStart(16, "0")
  }));
  const write = vi.fn(async () => {}),
    publish = vi.fn(async (arg: { write: () => Promise<void> }) => {
      await arg.write();
    });
  const unregister = vi.fn(),
    registerTarget = vi.fn(() => unregister);
  const context = {
    runtime: { handleUserMessage },
    surfaceReceiptAdmission: { admit },
    outwardEffects: { publish, registerTarget }
  };
  const host = new HostCharacterSurfaces(context as unknown as AppContext);
  const port = host.bind({
    surfaceId: "discord",
    principalNamespace: "discord:deployment:account",
    ...(selfActorId ? { selfActorId } : {}),
    resolvePerson: () =>
      bound
        ? { personId: "person:7", displayName: "Shared Person", bindingVersion: "binding:1" }
        : null,
    acceptsChannel: (c) => c === input.channelRef
  });
  const controller = new AbortController();
  let current = true;
  const connection = {
    generation: "g1",
    signal: controller.signal,
    isCurrent: () => current,
    write
  };
  return {
    host,
    port,
    handleUserMessage,
    admit,
    write,
    publish,
    unregister,
    connection,
    stale: () => {
      current = false;
      controller.abort();
    }
  };
}
describe("generic Character surface host", () => {
  it("preserves a received image observation when its admitted Character turn fails", async () => {
    const f = fixture();
    f.handleUserMessage.mockRejectedValueOnce(Error("generation failed"));
    const image = await f.port.receive(
      { ...input, hasImage: true },
      { ...f.connection, readImage: async () => ({ imageBase64: "AQID", mimeType: "image/png" }) }
    );
    expect(image).toMatchObject({ outcome: "FAILED", media: { availability: "RETRIEVABLE" } });
    expect(f.write).not.toHaveBeenCalled();
    await f.port.receive(
      {
        ...input,
        observations: [
          {
            text: "[Image attachment]",
            speaker: image.speaker,
            sourceJournalRef: image.sourceJournalRef,
            observedAt: new Date().toISOString(),
            media: image.media!
          }
        ]
      },
      f.connection
    );
    expect(f.handleUserMessage.mock.calls[1]?.[1]).toMatchObject({
      visualSources: [{ reference: image.media!.reference }]
    });
  });
  it("exposes a named observed image resource without attaching it or reading it until explicitly selected", async () => {
    const f = fixture();
    const read = vi.fn(async () => ({ imageBase64: "AQID", mimeType: "image/png" as const }));
    const { admission: _, ...ambient } = input;
    const observed = await f.port.receive(
      { ...ambient, hasImage: true, content: "[Image attachment]" },
      { ...f.connection, readImage: read }
    );
    expect(observed.outcome).toBe("OBSERVED");
    expect(read).not.toHaveBeenCalled();
    await f.port.receive(
      {
        ...input,
        observations: [
          {
            speaker: observed.speaker,
            text: "[Image attachment]",
            observedAt: new Date().toISOString(),
            sourceJournalRef: observed.sourceJournalRef,
            media: observed.media!
          }
        ]
      },
      f.connection
    );
    const options = f.handleUserMessage.mock.calls[0]![1] as {
      visualSources: Array<{ reference: string; read(signal: AbortSignal): Promise<unknown> }>;
      imageAttachment?: unknown;
    };
    expect(options.imageAttachment).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(options.visualSources[0]?.reference).toBe(observed.media?.reference);
    await options.visualSources[0]!.read(new AbortController().signal);
    expect(read).toHaveBeenCalledOnce();
  });
  it("does not expose a stale generation's observed image as a readable source", async () => {
    const f = fixture();
    const { admission: _, ...ambient } = input;
    const observed = await f.port.receive(
      { ...ambient, hasImage: true },
      { ...f.connection, readImage: async () => ({ imageBase64: "AQID", mimeType: "image/png" }) }
    );
    f.stale();
    await f.port.receive(
      {
        ...input,
        observations: [
          {
            speaker: observed.speaker,
            text: "old image",
            observedAt: new Date().toISOString(),
            sourceJournalRef: observed.sourceJournalRef,
            media: observed.media!
          }
        ]
      },
      { ...f.connection, signal: new AbortController().signal, isCurrent: () => true }
    );
    expect(f.handleUserMessage.mock.calls[0]?.[1]).toMatchObject({
      visualSources: [],
      socialContext: { observations: [{ media: { availability: "NOT_RETAINED" } }] }
    });
  });
  it("projects its actual ACK-confirmed publication as SELF with the originating turn, even without transport self echo", async () => {
    const f = fixture(true, "alice");
    const result = await f.port.receive(input, f.connection);
    expect(result.publication).toMatchObject({
      direction: "SELF",
      speaker: { principalId: "discord:deployment:account:alice" },
      text: "Alice reply",
      reply: { author: { personId: "person:7" }, text: "hello" }
    });
    expect(f.admit.mock.calls[1]?.[0]).toMatchObject({
      direction: "OUTBOUND",
      causalParents: [result.sourceJournalRef]
    });
  });
  it("observes ambient messages without model execution, conversation persistence or publication", async () => {
    const f = fixture();
    const { admission: _, ...ambient } = input;
    expect((await f.port.receive(ambient, f.connection)).outcome).toBe("OBSERVED");
    expect(f.admit).toHaveBeenCalledOnce();
    expect(f.handleUserMessage).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("binds the Product Person at the host and preserves read/write scope with untrusted proactive authority", async () => {
    const f = fixture();
    expect((await f.port.receive(input, f.connection)).outcome).toBe("RESPOND");
    expect(f.admit.mock.calls[0]?.[0]).toMatchObject({
      binding: { personId: "person:7", version: "binding:1" }
    });
    expect(f.handleUserMessage.mock.calls[0]?.[0]).toMatchObject({
      payload: { subjectUserId: "person:7", speakerId: "person:7" }
    });
    expect(f.handleUserMessage.mock.calls[0]?.[1]).toMatchObject({
      readMemory: true,
      writeMemory: true,
      controlAuthority: "UNTRUSTED",
      socialContext: {
        admission: "MENTION",
        speaker: { personId: "person:7" },
        mentions: ["discord:deployment:account:alice"]
      }
    });
    expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
      acknowledgementLayer: "EXTERNAL_SERVICE_ACCEPTED",
      target: { surface: "EXTERNAL_CHANNEL", targetGeneration: "g1" }
    });
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.unregister).toHaveBeenCalledOnce();
  });
  it("unbound sender cannot inherit a configured default Memory Person", async () => {
    const f = fixture(false);
    await f.port.receive(input, f.connection);
    expect(f.handleUserMessage.mock.calls[0]?.[1]).toMatchObject({
      readMemory: false,
      writeMemory: false
    });
    expect(f.handleUserMessage.mock.calls[0]?.[0]).toMatchObject({
      payload: { subjectUserId: "discord:deployment:account:7" }
    });
  });
  it("SILENCE means exactly zero publication calls and zero sends", async () => {
    const f = fixture();
    f.handleUserMessage.mockResolvedValueOnce(null as never);
    expect((await f.port.receive(input, f.connection)).outcome).toBe("SILENCE");
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it("fences stale generation while a Character is running", async () => {
    const f = fixture();
    f.handleUserMessage.mockImplementationOnce(async () => {
      f.stale();
      return { id: "reply", payload: { content: "late" } };
    });
    expect((await f.port.receive(input, f.connection)).outcome).toBe("STALE");
    expect(f.write).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("maps ambiguous publication to UNKNOWN without a second write", async () => {
    const f = fixture();
    f.publish.mockImplementationOnce(async ({ write }) => {
      await write();
      throw Error("ACK lost");
    });
    expect((await f.port.receive(input, f.connection)).outcome).toBe("UNKNOWN");
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledOnce();
  });
  it("projects uncertain generated text as UNKNOWN without treating it as an acknowledged expression or retrying", async () => {
    const f = fixture(true, "alice");
    f.publish.mockRejectedValueOnce(Error("ACK missing"));
    const result = await f.port.receive(input, f.connection);
    expect(result).toMatchObject({
      outcome: "UNKNOWN",
      publication: { direction: "SELF", publicationState: "UNKNOWN", text: "Alice reply" }
    });
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.admit.mock.calls[1]?.[0]).toMatchObject({
      transportFacts: expect.stringContaining('"publicationState":"UNKNOWN"')
    });
    expect(JSON.stringify(f.admit.mock.calls[1])).not.toContain("EXTERNAL_SERVICE_ACCEPTED");
  });

  it("passes image bytes through the existing Runtime visual API and seals ingress on close", async () => {
    const f = fixture();
    const imageAttachment = { imageBase64: "AA==", mimeType: "image/png" as const };
    await f.port.receive(
      { ...input, hasImage: true },
      { ...f.connection, readImage: async () => imageAttachment }
    );
    expect(f.handleUserMessage.mock.calls[0]?.[1]).toMatchObject({
      imageAttachment,
      socialContext: { media: { image: "ATTACHED" } }
    });
    await f.host.close();
    await expect(f.port.receive(input, f.connection)).rejects.toThrow("sealed");
  });
  it("records unavailable image evidence without pretending the Character received image bytes", async () => {
    const f = fixture();
    await f.port.receive(
      { ...input, hasImage: true },
      { ...f.connection, readImage: async () => undefined }
    );
    expect(f.handleUserMessage.mock.calls[0]?.[1]).toMatchObject({
      socialContext: { media: { image: "UNAVAILABLE" } }
    });
    expect(f.handleUserMessage.mock.calls[0]?.[1]).not.toHaveProperty("imageAttachment");
  });
});
