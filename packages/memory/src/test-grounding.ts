import type { JournalEventRef } from "@companion/protocol";
import { MemoryService } from "./service.js";
import type {
  CreateMemoryInput,
  MemoryCandidate,
  MemoryGroundingContext,
  MemoryGroundingResolver
} from "./types.js";

export const TEST_MEMORY_GROUNDING_CONTEXT: MemoryGroundingContext = {
  sourceJournalRef: {
    kind: "JOURNAL_EVENT",
    namespace: "test-only-memory-journal",
    eventId: "jev1_aaaaaaaaaaaaaaaa"
  },
  sourceText: "Explicit test-only committed user source."
};
const testReceiptTimes = new WeakMap<object, string>();

const testResolver: MemoryGroundingResolver = {
  async resolve(context) {
    const parent: JournalEventRef = context.sourceJournalRef;
    const payloadRef = {
      namespace: parent.namespace,
      payloadId: "test-only-payload",
      version: "v1"
    };
    const characterCount = Array.from(context.sourceText).length;
    return {
      parent,
      selector: {
        version: "source-selector.v1",
        modality: "TEXT",
        payload: payloadRef,
        range: {
          unit: "UNICODE_CODE_POINT",
          start: 0,
          end: characterCount
        }
      },
      payload: {
        ref: payloadRef,
        modality: "TEXT",
        retention: "RETAINED",
        origin: "USER_INPUT",
        selectable: true,
        characterCount
      },
      selectedText: context.sourceText,
      origin: "USER_ASSERTION",
      recordedAt:
        testReceiptTimes.get(context) ?? "2026-09-30T00:00:00.000Z",
      occurrenceTime: { state: "UNKNOWN" },
      authority: {
        principal: { state: "UNRESOLVED", reason: "test-only source" },
        binding: { state: "UNRESOLVED", reason: "test-only source" },
        audience: { kind: "UNKNOWN", reason: "test-only source" }
      }
    };
  }
};

/** Legacy policy tests use an explicit deterministic test receipt, never a production bypass. */
export class GroundedMemoryTestService extends MemoryService {
  constructor(...args: ConstructorParameters<typeof MemoryService>) {
    const [repository, scorer, retriever, extractor, embedding, backend] = args;
    super(repository, scorer, retriever, extractor, embedding, {
      ...backend,
      kind: backend?.kind ?? "legacy",
      groundingResolver: testResolver
    });
  }

  override processCandidateForStorage(
    candidate: MemoryCandidate,
    options: {
      source?: string;
      tags?: string[];
      skipAdmissionPolicy?: boolean;
      storageReason?: string;
    } = {},
    groundingContext?: MemoryGroundingContext
  ) {
    return super.processCandidateForStorage(
      candidate,
      options,
      groundingContext ?? createTestContextForCandidate(candidate)
    );
  }

  override rememberCandidate(
    candidate: MemoryCandidate,
    options: { source?: string; tags?: string[] } = {},
    groundingContext?: MemoryGroundingContext
  ) {
    return super.rememberCandidate(
      candidate,
      options,
      groundingContext ?? createTestContextForCandidate(candidate)
    );
  }

  override createMemory(input: CreateMemoryInput) {
    return super.createMemory({
      ...input,
      evidenceClassification: input.evidenceClassification ?? "NON_EVIDENCE"
    });
  }
}

function createTestContextForCandidate(candidate: MemoryCandidate): MemoryGroundingContext {
  const context: MemoryGroundingContext = {
    sourceJournalRef: TEST_MEMORY_GROUNDING_CONTEXT.sourceJournalRef,
    sourceText: candidate.evidenceText ?? candidate.content
  };
  const time = candidate.observedAt;
  if (time !== undefined && time !== null) {
    const parsed = new Date(time);
    if (Number.isFinite(parsed.getTime())) testReceiptTimes.set(context, parsed.toISOString());
  }
  return context;
}

export function createGroundedMemoryTestService(
  ...args: ConstructorParameters<typeof MemoryService>
): GroundedMemoryTestService {
  return new GroundedMemoryTestService(...args);
}
