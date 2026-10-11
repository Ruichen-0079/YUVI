import type { MemoryLegacyWorkflowView } from "./legacy-workflow.js";
import type { MemoryRetrievalPage, MemoryRetrievalDetail } from "./retrieval-evidence.js";
import type {
  KnowledgeOverview,
  KnowledgePage,
  KnowledgeRecord,
  KnowledgeState,
  MemoryProcessingView,
  AuthorityRelation
} from "./types.js";
export type MemoryProductError = {
  schema: "memory.error.v1";
  status: "UNKNOWN" | "FAILED";
  error: string;
};
/** Supply the existing authenticated HTTP transport; never stores a token in a URL. */
export class MemoryKnowledgeClient {
  constructor(private readonly request: <T>(path: string) => Promise<T>) {}
  overview(scope: string) {
    return this.request<KnowledgeOverview>(this.url("overview", { scope }));
  }
  current(input: { scope: string; limit?: number; cursor?: string; state?: KnowledgeState }) {
    return this.request<KnowledgePage>(this.url("current", input));
  }
  timeline(input: { scope: string; limit?: number; cursor?: string }) {
    return this.request<KnowledgePage>(this.url("timeline", input));
  }
  detail(scope: string, id: string) {
    return this.request<KnowledgeRecord>(this.url("detail", { scope, id }));
  }
  relations(scope: string, id: string) {
    return this.request<{
      schema: "memory.relations.v1";
      relations: AuthorityRelation[];
      limited: boolean;
    }>(this.url("relations", { scope, id }));
  }
  processing(scope: string, id: string) {
    return this.request<MemoryProcessingView>(this.url("processing", { scope, id }));
  }
  ingestion(scope: string, id: string) {
    return this.request<{
      schema: "memory.ingestion.v1";
      status: string;
      errorCode?: string | null;
    }>(this.url("ingestion", { scope, id }));
  }
  retrievals(input: { scope: string; traceId?: string; limit?: number; cursor?: string }) {
    return this.request<MemoryRetrievalPage>(this.url("retrievals", input));
  }
  retrieval(scope: string, id: string) {
    return this.request<MemoryRetrievalDetail>(this.url("retrieval", { scope, id }));
  }
  migration(scope: string, id: string) {
    return this.request<MemoryLegacyWorkflowView>(this.url("migration", { scope, id }));
  }
  private url(operation: string, input: Record<string, string | number | undefined>) {
    const qs = new URLSearchParams(
      Object.entries(input)
        .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
        .map(([k, v]): [string, string] => [k, String(v)])
    );
    return `/memory/v1/${operation}?${qs}`;
  }
}
