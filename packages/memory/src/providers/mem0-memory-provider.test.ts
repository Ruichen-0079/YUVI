import { describe, expect, it, vi } from "vitest";
import {
  MemoryBackendError,
  type MemoryBackend,
  type MemoryRecord,
  type MemorySearchResult
} from "../backend.js";
import { buildMemoryScope } from "../scope.js";
import {
  MEM0_MEMORY_SOURCE,
  Mem0MemoryProvider,
  Mem0MemoryProviderError,
  buildWriteMetadata,
  canonicalMem0EventId,
  mapMem0RecordToMemoryEvent
} from "./mem0-memory-provider.js";

const scope = buildMemoryScope("user-a", "alice");

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "record-1",
    content: "  The user prefers short replies.  ",
    scope,
    metadata: {},
    ...overrides
  };
}

function searchRecord(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return { ...record(overrides), score: 0.99 };
}

function backend(overrides: Partial<MemoryBackend> = {}): MemoryBackend {
  return {
    kind: "mem0",
    health: vi.fn(),
    add: vi.fn(),
    search: vi.fn(async () => []),
    get: vi.fn(async () => null),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    history: vi.fn(),
    ...overrides
  } as MemoryBackend;
}

describe("Mem0MemoryProvider canonical mapping", () => {
  it("accepts a mem0 backend", () => {
    expect(() => new Mem0MemoryProvider(backend())).not.toThrow();
  });

  it.each(["legacy", "shadow"] as const)(
    "rejects a %s backend before any storage operation",
    (kind) => {
      const search = vi.fn(async () => []);
      const get = vi.fn(async () => null);
      const add = vi.fn(async () => ({
        memoryId: "should-not-write",
        operation: "created" as const
      }));
      const invalidBackend = backend({ kind, search, get, add });

      let thrown: unknown;
      try {
        new Mem0MemoryProvider(invalidBackend);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Mem0MemoryProviderError);
      expect(thrown).toMatchObject({ code: "MEMORY_BACKEND_KIND_INVALID" });
      expect(search).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
    }
  );

  it("maps a backend record to a trimmed canonical event owned by mem0", () => {
    const event = mapMem0RecordToMemoryEvent(record(), scope);
    expect(event).toMatchObject({
      id: "mem0:record-1",
      source: MEM0_MEMORY_SOURCE,
      sourceRecordId: "record-1",
      content: "The user prefers short replies.",
      scope
    });
  });

  it("keeps stable IDs independent of retrieval order and deduplicates only duplicate IDs", async () => {
    const search = vi.fn(async () => [
      searchRecord({ id: "a" }),
      searchRecord({ id: "a", content: "duplicate" }),
      searchRecord({ id: "b" })
    ]);
    const provider = new Mem0MemoryProvider(backend({ search }));
    const result = await provider.retrieveRelevant({ text: "preference", scope });
    expect(result.events.map((item) => item.id)).toEqual(["mem0:a", "mem0:b"]);
    expect(result.events.map((item) => item.sourceRecordId)).toEqual(["a", "b"]);
    expect(canonicalMem0EventId("a")).toBe("mem0:a");
  });

  it("returns the same identity and provenance through retrieve then get", async () => {
    const source = record({
      id: "stable",
      metadata: {
        sourceMessageId: "m-1",
        assistantMessageId: "a-1",
        conversationId: "conversation-1",
        userId: "user-a",
        characterId: "alice"
      }
    });
    const provider = new Mem0MemoryProvider(
      backend({
        search: vi.fn(async () => [searchRecord({ ...source, score: 0.8 })]),
        get: vi.fn(async () => source)
      })
    );
    const retrieved = await provider.retrieveRelevant({ text: "hello", scope });
    const first = retrieved.events[0];
    expect(first).toBeDefined();
    const fetched = await provider.getEvent({ id: first!.id, scope });
    expect(fetched).toEqual(retrieved.events[0]);
  });

  it("fails closed when retrieval scope is missing", async () => {
    const search = vi.fn(async () => []);
    const provider = new Mem0MemoryProvider(backend({ search }));
    await expect(provider.retrieveRelevant({ text: "hello" })).resolves.toMatchObject({
      status: "error",
      events: [],
      errorCode: "MEMORY_SCOPE_MISSING"
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("derives the existing encoded scope only when both identities are present", async () => {
    const search = vi.fn(async () => []);
    const provider = new Mem0MemoryProvider(backend({ search }));
    await provider.retrieveRelevant({ text: "hello", subjectUserId: "user-a", personaId: "alice" });
    expect(search).toHaveBeenCalledWith({ scope, query: "hello" }, undefined);
  });

  it("rejects a search record whose scope conflicts with the request", async () => {
    const provider = new Mem0MemoryProvider(
      backend({
        search: vi.fn(async () => [searchRecord({ scope: buildMemoryScope("other", "alice") })])
      })
    );
    await expect(provider.retrieveRelevant({ text: "hello", scope })).resolves.toMatchObject({
      status: "error",
      events: [],
      errorCode: "MEMORY_SCOPE_MISMATCH"
    });
  });

  it("maps explicit legacy records to an unverified user claim", () => {
    const event = mapMem0RecordToMemoryEvent(
      record({ metadata: { memoryType: "explicit" } }),
      scope
    );
    expect(event.kind).toBe("user_claim");
    expect(event.assertion).toEqual({ source: "user", verification: "unverified" });
  });

  it("maps conversation records conservatively to fact without assertion", () => {
    const event = mapMem0RecordToMemoryEvent(
      record({ metadata: { memoryType: "conversation" } }),
      scope
    );
    expect(event.kind).toBe("fact");
    expect(event.assertion).toBeUndefined();
  });

  it("uses only legal provider-owned kind metadata and never infers from text", () => {
    expect(mapMem0RecordToMemoryEvent(record({ content: "I feel angry" }), scope).kind).toBe(
      "fact"
    );
    expect(
      mapMem0RecordToMemoryEvent(record({ metadata: { yuviEventKind: "episodic" } }), scope).kind
    ).toBe("episodic");
  });

  it("maps valid createdAt to recordedAt only", () => {
    const event = mapMem0RecordToMemoryEvent(
      record({ createdAt: "2025-01-02T03:04:05.000Z" }),
      scope
    );
    expect(event.recordedAt).toBe("2025-01-02T03:04:05.000Z");
    expect(event.observedAt).toBeUndefined();
    expect(event.occurredAt).toBeUndefined();
  });

  it("leaves missing or invalid timestamps unknown without reading the clock", () => {
    const now = vi.spyOn(Date, "now");
    const event = mapMem0RecordToMemoryEvent(record({ createdAt: "not-a-time" }), scope);
    expect(event.recordedAt).toBeUndefined();
    expect(event.observedAt).toBeUndefined();
    expect(event.occurredAt).toBeUndefined();
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("maps only explicit observed and occurred metadata", () => {
    const event = mapMem0RecordToMemoryEvent(
      record({
        createdAt: "2025-01-02T03:04:05.000Z",
        metadata: {
          yuviObservedAt: "2025-01-03T03:04:05.000Z",
          yuviOccurredAt: "2025-01-01T03:04:05.000Z"
        }
      }),
      scope
    );
    expect(event.observedAt).toBe("2025-01-03T03:04:05.000Z");
    expect(event.occurredAt).toBe("2025-01-01T03:04:05.000Z");
  });

  it("preserves source turn provenance, conversation, and explicit identity participants", () => {
    const event = mapMem0RecordToMemoryEvent(
      record({
        metadata: {
          sourceMessageId: "m-1",
          assistantMessageId: "a-1",
          sourceTraceId: "trace-1",
          conversationId: "conversation-1",
          userId: "user-a",
          characterId: "alice",
          yuviSourceTurnIds: ["m-1", "m-2"],
          name: "Do not become a participant"
        }
      }),
      scope
    );
    expect(event.sourceTurnIds).toEqual(["m-1", "a-1", "m-2"]);
    expect(event.conversationId).toBe("conversation-1");
    expect(event.participants).toEqual(["user-a", "alice"]);
    expect(event.metadata["sourceTraceId"]).toBe("trace-1");
    expect(event.participants).not.toContain("Do not become a participant");
  });

  it("does not map query-specific search score to confidence", async () => {
    const provider = new Mem0MemoryProvider(
      backend({ search: vi.fn(async () => [searchRecord({ score: 1 })]) })
    );
    const result = await provider.retrieveRelevant({ text: "hello", scope });
    expect(result.events[0]).not.toHaveProperty("confidence");
  });

  it("returns empty for a successful search with no hits", async () => {
    const provider = new Mem0MemoryProvider(backend());
    await expect(provider.retrieveRelevant({ text: "hello", scope })).resolves.toMatchObject({
      status: "empty",
      events: [],
      rawCount: 0,
      selectedCount: 0
    });
  });

  it("maps timeout and retryable transport errors to unavailable", async () => {
    const timeout = new Mem0MemoryProvider(
      backend({
        search: vi.fn(async () => {
          throw new MemoryBackendError("OPERATION_TIMEOUT", "timeout");
        })
      })
    );
    await expect(timeout.retrieveRelevant({ text: "hello", scope })).resolves.toMatchObject({
      status: "unavailable",
      errorCode: "OPERATION_TIMEOUT",
      events: []
    });
    const retryable = new Mem0MemoryProvider(
      backend({
        search: vi.fn(async () => {
          throw new MemoryBackendError("INTERNAL_ERROR", "down", { retryable: true });
        })
      })
    );
    await expect(retryable.retrieveRelevant({ text: "hello", scope })).resolves.toMatchObject({
      status: "unavailable",
      errorCode: "MEMORY_UNAVAILABLE"
    });
  });

  it("maps validation/protocol and unexpected errors to error, never empty", async () => {
    const validation = new Mem0MemoryProvider(
      backend({
        search: vi.fn(async () => {
          throw new MemoryBackendError("VALIDATION_ERROR", "bad scope");
        })
      })
    );
    await expect(validation.retrieveRelevant({ text: "hello", scope })).resolves.toMatchObject({
      status: "error",
      errorCode: "VALIDATION_ERROR",
      events: []
    });
    const unexpected = new Mem0MemoryProvider(
      backend({
        search: vi.fn(async () => {
          throw new Error("bad response");
        })
      })
    );
    await expect(unexpected.retrieveRelevant({ text: "hello", scope })).resolves.toMatchObject({
      status: "error",
      errorCode: "MEMORY_PROVIDER_ERROR",
      events: []
    });
  });

  it("reports a successful top-k cap as ok and limited", async () => {
    const provider = new Mem0MemoryProvider(
      backend({
        search: vi.fn(async () => [searchRecord({ id: "one" }), searchRecord({ id: "two" })])
      })
    );
    await expect(
      provider.retrieveRelevant({ text: "hello", scope, limit: 2 })
    ).resolves.toMatchObject({
      status: "ok",
      limited: true,
      limitReason: "top-k-cap"
    });
  });

  it("requires scope and infer=false for semantic writes, with no messages", async () => {
    const add = vi.fn(async () => ({ memoryId: "write-1", operation: "created" as const }));
    const provider = new Mem0MemoryProvider(backend({ add }));
    const outcome = await provider.writeEvent({
      kind: "fact",
      content: "  User prefers tea. ",
      scope,
      sourceTurnIds: ["m-1"],
      assertion: { source: "user", verification: "unverified" }
    });
    expect(outcome).toMatchObject({ status: "written", eventId: "mem0:write-1", event: null });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ scope, content: "User prefers tea.", infer: false }),
      undefined
    );
    const addInput = (add.mock.calls[0] as unknown[])[0] as { metadata?: Record<string, unknown> };
    expect(addInput).not.toHaveProperty("messages");
    expect(addInput.metadata).toMatchObject({
      yuviEventKind: "fact",
      yuviSourceTurnIds: ["m-1"],
      yuviAssertionSource: "user",
      yuviVerification: "unverified"
    });
  });

  it("persists and restores claim attribution without rewriting the raw mention", async () => {
    const writeRecord = record({
      id: "claim-1",
      content: "今天怎么了",
      metadata: {
        yuviEventKind: "user_claim",
        yuviClaimProvenanceClass: "EXTERNAL_CLAIM",
        yuviClaimAssertorEntityId: "person_ruichen",
        yuviClaimAssertorResolution: "resolved",
        yuviClaimSubjectEntityId: "entity_yuvi",
        yuviClaimSubjectSurfaceMention: "UV",
        yuviClaimSubjectResolution: "resolved",
        yuviClaimRawText: "UV 今天怎么了",
        yuviSourceObservationId: "obs-1"
      }
    });
    const add = vi.fn(async () => ({
      memoryId: "claim-1",
      operation: "created" as const,
      record: writeRecord
    }));
    const provider = new Mem0MemoryProvider(backend({ add }));
    const outcome = await provider.writeEvent({
      kind: "user_claim",
      content: "今天怎么了",
      scope,
      assertion: { source: "user", verification: "unverified" },
      claim: {
        provenanceClass: "EXTERNAL_CLAIM",
        rawText: "UV 今天怎么了",
        assertor: { entityId: "person_ruichen", resolution: "resolved" },
        subject: { entityId: "entity_yuvi", surfaceMention: "UV", resolution: "resolved" },
        sourceObservation: { observationId: "obs-1" }
      }
    });
    expect(outcome.event?.claim).toMatchObject({
      provenanceClass: "EXTERNAL_CLAIM",
      rawText: "UV 今天怎么了",
      subject: { entityId: "entity_yuvi", surfaceMention: "UV", resolution: "resolved" },
      sourceObservation: { observationId: "obs-1" }
    });
    expect(outcome.event?.content).toBe("今天怎么了");
    const addInput = (add.mock.calls[0] as unknown[])[0] as { metadata?: Record<string, unknown> };
    expect(addInput.metadata).toMatchObject({
      yuviClaimRawText: "UV 今天怎么了",
      yuviClaimSubjectSurfaceMention: "UV",
      yuviClaimSubjectEntityId: "entity_yuvi"
    });
    expect(JSON.stringify(addInput.metadata)).not.toContain("YUVI 今天怎么了");
  });

  it("rejects a semantic write without scope before touching the backend", async () => {
    const add = vi.fn();
    const provider = new Mem0MemoryProvider(backend({ add }));
    await expect(
      provider.writeEvent({ kind: "fact", content: "fact", scope: "" })
    ).resolves.toEqual({
      status: "rejected",
      errorCode: "MEMORY_SCOPE_MISSING",
      failureClass: "definitive_rejection"
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("retains eventId for unchanged writes and records supplied events", async () => {
    const writeRecord = record({ id: "unchanged", content: "Fact" });
    const add = vi.fn(async () => ({
      memoryId: "unchanged",
      operation: "unchanged" as const,
      record: writeRecord
    }));
    const provider = new Mem0MemoryProvider(backend({ add }));
    const outcome = await provider.writeEvent({ kind: "fact", content: "Fact", scope });
    expect(outcome.status).toBe("unchanged");
    expect(outcome.eventId).toBe("mem0:unchanged");
    expect(outcome.event?.id).toBe("mem0:unchanged");
  });

  it("redacts sensitive metadata and preserves bounded semantic arrays", () => {
    const metadata = buildWriteMetadata({
      kind: "fact",
      content: "fact",
      scope,
      sourceTurnIds: ["m-1", "m-2"],
      participants: ["user-a", "alice"],
      metadata: {
        apiKey: "never propagate",
        authorization: "Bearer secret",
        nested: { unsafe: true },
        sourceTraceId: "trace-1",
        embedding: "0.1,0.2",
        rawEmbedding: "[0.1]",
        waveform: "pcm"
      }
    });
    expect(metadata).toMatchObject({
      yuviSourceTurnIds: ["m-1", "m-2"],
      yuviParticipants: ["user-a", "alice"],
      sourceTraceId: "trace-1"
    });
    expect(metadata).not.toHaveProperty("apiKey");
    expect(metadata).not.toHaveProperty("authorization");
    expect(metadata).not.toHaveProperty("nested");
    expect(metadata).not.toHaveProperty("embedding");
    expect(metadata).not.toHaveProperty("rawEmbedding");
    expect(metadata).not.toHaveProperty("waveform");
  });

  it("fails closed for wrong canonical prefixes and does not call backend", async () => {
    const get = vi.fn(async () => record());
    const provider = new Mem0MemoryProvider(backend({ get }));
    await expect(provider.getEvent({ id: "legacy:record-1", scope })).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("fails closed for mismatched get records", async () => {
    const get = vi.fn(async () => record({ scope: buildMemoryScope("other", "alice") }));
    const provider = new Mem0MemoryProvider(backend({ get }));
    await expect(provider.getEvent({ id: "mem0:record-1", scope })).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith({ memoryId: "record-1", scope }, undefined);
  });

  it("does not treat an unexpected deleted operation as a successful write", async () => {
    const provider = new Mem0MemoryProvider(
      backend({ add: vi.fn(async () => ({ memoryId: "gone", operation: "deleted" as const })) })
    );
    await expect(
      provider.writeEvent({ kind: "fact", content: "fact", scope })
    ).resolves.toMatchObject({
      status: "rejected",
      eventId: "mem0:gone",
      errorCode: "MEMORY_WRITE_UNEXPECTED_DELETE"
    });
  });

  it("classifies definitive backend rejection separately from uncertain transport failure", async () => {
    const validation = new Mem0MemoryProvider(
      backend({
        add: vi.fn(async () => {
          throw new MemoryBackendError("VALIDATION_ERROR", "invalid request");
        })
      })
    );
    await expect(validation.writeEvent({ kind: "fact", content: "fact", scope })).resolves.toEqual({
      status: "rejected",
      errorCode: "VALIDATION_ERROR",
      failureClass: "definitive_rejection"
    });

    const uncertain = new Mem0MemoryProvider(
      backend({
        add: vi.fn(async () => {
          throw new MemoryBackendError("OPERATION_TIMEOUT", "timeout", { retryable: true });
        })
      })
    );
    await expect(uncertain.writeEvent({ kind: "fact", content: "fact", scope })).resolves.toEqual({
      status: "rejected",
      errorCode: "OPERATION_TIMEOUT",
      failureClass: "ambiguous"
    });
  });

  it("uses keyed submit and preserves exact reconciliation outcomes", async () => {
    const submitIdempotent = vi.fn(async () => ({
      memoryId: "stable-memory",
      operation: "created" as const
    }));
    const reconcileIdempotency = vi.fn(async () => ({
      status: "applied" as const,
      memoryId: "stable-memory",
      operation: "created"
    }));
    const provider = new Mem0MemoryProvider(backend({ submitIdempotent, reconcileIdempotency }));
    const input = {
      kind: "fact" as const,
      content: "fact",
      scope,
      idempotencyKey: "key-1",
      payloadDigest: "digest-1"
    };
    await expect(provider.writeEventIdempotent!(input)).resolves.toMatchObject({
      status: "written",
      eventId: "mem0:stable-memory"
    });
    await expect(provider.reconcileEvent!(input)).resolves.toEqual({
      status: "applied",
      memoryId: "stable-memory",
      operation: "created"
    });
    expect(submitIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "key-1", payloadDigest: "digest-1" }),
      undefined
    );
  });

  it.each([
    ["missing record id", record({ id: "" })],
    ["unexpected record scope", record({ scope: buildMemoryScope("other", "alice") })]
  ] as const)(
    "classifies a %s after successful keyed submit as ambiguous",
    async (_label, malformedRecord) => {
      const submitIdempotent = vi.fn(async () => ({
        memoryId: "stable-memory",
        operation: "created" as const,
        record: malformedRecord
      }));
      const provider = new Mem0MemoryProvider(backend({ submitIdempotent }));

      await expect(
        provider.writeEventIdempotent!({
          kind: "fact",
          content: "fact",
          scope,
          idempotencyKey: "key-post-dispatch",
          payloadDigest: "digest-post-dispatch"
        })
      ).resolves.toMatchObject({
        status: "rejected",
        eventId: "mem0:stable-memory",
        failureClass: "ambiguous"
      });
    }
  );

  it("keeps an invalid successful operation ambiguous after keyed submit", async () => {
    const provider = new Mem0MemoryProvider(
      backend({
        submitIdempotent: vi.fn(async () => ({
          memoryId: "stable-memory",
          operation: "deleted" as const
        }))
      })
    );

    await expect(
      provider.writeEventIdempotent!({
        kind: "fact",
        content: "fact",
        scope,
        idempotencyKey: "key-invalid-operation",
        payloadDigest: "digest-invalid-operation"
      })
    ).resolves.toMatchObject({
      status: "rejected",
      eventId: "mem0:stable-memory",
      errorCode: "MEMORY_WRITE_OPERATION_INVALID",
      failureClass: "ambiguous"
    });
  });

  it.each(["not_applied", "in_flight", "payload_conflict", "unknown"] as const)(
    "does not collapse exact reconciliation status %s",
    async (status) => {
      const provider = new Mem0MemoryProvider(
        backend({ reconcileIdempotency: vi.fn(async () => ({ status })) })
      );
      await expect(
        provider.reconcileEvent!({ idempotencyKey: "key-1", payloadDigest: "digest-1" })
      ).resolves.toMatchObject({ status });
    }
  );

  it("notifies the original reconciliation scope without changing an ambiguous outcome", async () => {
    const notices: Array<{ scope: string; reason: string }> = [];
    const provider = new Mem0MemoryProvider(
      backend({ reconcileIdempotency: vi.fn(async () => ({ status: "in_flight" as const })) }),
      async (notice) => {
        notices.push(notice);
        throw new Error("lifecycle store unavailable");
      }
    );
    await expect(
      provider.reconcileEvent!({ idempotencyKey: "key-1", payloadDigest: "digest-1", scope })
    ).resolves.toMatchObject({ status: "in_flight" });
    expect(notices).toEqual([{ scope, reason: "DELIVERY_OBSERVED" }]);
    expect(provider.getProfileNotificationFailureCount()).toBe(1);
  });
});
