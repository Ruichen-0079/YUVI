import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { JournalRepository } from "@companion/journal";
import type { AuthorityPool } from "@companion/memory";
import type { ObservationEvidence } from "@companion/protocol";
import { HostObservationContinuity } from "./observation-continuity.js";
import type { ConversationHostIdentity } from "./conversation-host-identity.js";
afterEach(() => vi.restoreAllMocks());
it("checks image TTL again after the valid SQL snapshot, grant lookups and encoding", async () => {
  const start = Date.parse("2030-01-01T00:00:00Z"),
    bytes = Buffer.from("synthetic-image-fixture");
  const source = {
    kind: "JOURNAL_EVENT" as const,
    namespace: "observation-unit",
    eventId: "jev1_aaaaaaaaaaaaaaaa"
  };
  const authority = {
    principal: { state: "RESOLVED", namespace: "observation-unit", actorId: "actor" },
    binding: { state: "RESOLVED", personId: "person" },
    audience: { kind: "PRIVATE", channelRef: "private" }
  };
  const journal = {
    namespace: source.namespace,
    get: async () => ({ authority })
  } as unknown as JournalRepository;
  const host = {
    readAuthority: async () => ({
      principal: { namespace: source.namespace, actorId: "actor" },
      personId: "person"
    })
  } as unknown as ConversationHostIdentity;
  const record: ObservationEvidence = {
    schema: "observation.v1",
    id: "ob1_" + "a".repeat(64),
    kind: "VISION",
    availability: "AVAILABLE",
    source,
    observedAt: new Date(start).toISOString(),
    expiresAt: new Date(start + 100).toISOString(),
    action: {
      attemptId: "ea1_" + "b".repeat(64),
      contractRef: "yuvi.provider.v1",
      certainty: "APPLIED"
    },
    goalStatus: "NOT_INFERRED",
    coverage: "BOUNDED_PROVIDER_REPORT",
    provider: "fixture",
    model: "fixture",
    evidence: { text: "fixture", sceneSummary: "", objects: [], confidence: null },
    sourceArtifact: "AVAILABLE"
  };
  const clock = vi.spyOn(Date, "now");
  for (const delay of [0, 150]) {
    clock.mockReturnValue(start);
    const db = {
      query: async () => {
        clock.mockReturnValue(start + delay);
        return {
          rows: [
            {
              image_bytes: bytes,
              image_mime: "image/png",
              image_digest: createHash("sha256").update(bytes).digest("hex")
            }
          ]
        };
      }
    } as unknown as AuthorityPool;
    const baselineFile = process.env["YUVI_OBSERVATION_TTL_BASELINE"];
    const Continuity = baselineFile
      ? ((await import(pathToFileURL(baselineFile).href))
          .HostObservationContinuity as typeof HostObservationContinuity)
      : HostObservationContinuity;
    const port = new Continuity(db, journal, host, "persona", {
      seconds: 60,
      retainImages: true
    });
    vi.spyOn(port, "detail").mockResolvedValue(record); // SQL snapshot was valid; this test isolates the later disclosure boundary.
    const result = await port.image({ sourceJournalRef: source, sessionId: "session" }, record.id);
    expect(result).toEqual(
      delay ? null : { imageBase64: bytes.toString("base64"), mimeType: "image/png" }
    );
  }
});
