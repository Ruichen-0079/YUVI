import {
  ProfileSnapshotConflictError,
  ProfileSnapshotCorruptionError,
  ProfileSnapshotV1Schema,
  PROFILE_MATERIALIZER_VERSION,
  PROFILE_VERSION,
  ProfileValidationError,
  parseProfileSubject,
  validateProfileSnapshot,
  type ProfileFailureCode,
  type ProfileGenerationOutcome,
  type ProfileMemorySourceReader,
  type ProfileProvider,
  type ProfileProviderCapabilities,
  type ProfileReadOutcome,
  type ProfileSubjectV1
} from "./profile-types.js";
import { ProfileMaterializationError, materializeProfileSnapshot } from "./profile-materializer.js";
import {
  ProfileSnapshotStoreUnavailableError,
  type ProfileSnapshotStore
} from "./profile-snapshot-store.js";

export type LocalProfileProviderOptions = {
  resolveSourceReader: (subject: ProfileSubjectV1) => ProfileMemorySourceReader;
  store: ProfileSnapshotStore;
  now?: () => string | Date;
};

export class LocalProfileProvider implements ProfileProvider {
  private readonly now: () => string | Date;

  constructor(private readonly options: LocalProfileProviderOptions) {
    this.now = options.now ?? (() => new Date());
  }

  capabilities(): ProfileProviderCapabilities {
    return {
      providerId: "yuvi-local-profile",
      providerVersion: "1",
      localPrivate: true,
      hosted: false,
      asyncGeneration: false,
      schemaVersion: PROFILE_VERSION,
      materializerVersion: PROFILE_MATERIALIZER_VERSION,
      sourceBackends: ["legacy", "mem0"]
    };
  }

  async getProfile(input: { subject: ProfileSubjectV1; profileRevision?: string; signal?: AbortSignal }): Promise<ProfileReadOutcome> {
    const subject = parseProfileSubject(input.subject);
    if (input.profileRevision !== undefined && !/^pf1_[a-f0-9]{64}$/u.test(input.profileRevision)) {
      throw new ProfileValidationError("profileRevision is invalid.");
    }
    if (input.signal?.aborted) return { state: "UNAVAILABLE", snapshot: null, code: "STORE_UNAVAILABLE" };
    try {
      const snapshot = input.profileRevision === undefined
        ? await this.options.store.getCurrent({ subject })
        : await this.options.store.getRevision({ subject, profileRevision: input.profileRevision });
      if (!snapshot) return { state: "NOT_FOUND", snapshot: null };
      const checked = validateProfileSnapshot(snapshot);
      if (checked.profileRevision !== input.profileRevision && input.profileRevision !== undefined) {
        throw new ProfileSnapshotCorruptionError();
      }
      if (JSON.stringify(checked.subject) !== JSON.stringify(subject)) throw new ProfileSnapshotCorruptionError();
      return { state: checked.generationState, snapshot: checked, freshness: "UNCHECKED" };
    } catch (error) {
      return mapReadStoreFailure(error);
    }
  }

  async generate(input: { subject: ProfileSubjectV1; signal?: AbortSignal }): Promise<ProfileGenerationOutcome> {
    const subject = parseProfileSubject(input.subject);
    const captured = this.now();
    const generatedAt = captured instanceof Date ? captured.toISOString() : captured;
    if (!Number.isFinite(Date.parse(generatedAt)) || new Date(generatedAt).toISOString() !== generatedAt) {
      throw new ProfileValidationError("Provider clock must return a canonical ISO UTC instant.");
    }
    if (input.signal?.aborted) return { state: "UNAVAILABLE", snapshot: null, code: "SOURCE_UNAVAILABLE", sourceRead: null };
    // Resolve exactly once so a hot reload cannot combine two active Memory backends.
    let reader: ProfileMemorySourceReader;
    try { reader = this.options.resolveSourceReader(subject); }
    catch { return { state: "UNAVAILABLE", snapshot: null, code: "SOURCE_UNAVAILABLE", sourceRead: null }; }
    let sourceRead;
    try {
      sourceRead = await reader.listEligibleSources({ subject, asOf: generatedAt, ...(input.signal ? { signal: input.signal } : {}) });
    } catch {
      return { state: input.signal?.aborted ? "UNAVAILABLE" : "FAILED", snapshot: null, code: input.signal?.aborted ? "SOURCE_UNAVAILABLE" : "SOURCE_ERROR", sourceRead: null };
    }
    if (sourceRead.state === "PARTIAL") return { state: "PARTIAL", snapshot: null, code: "SOURCE_PARTIAL", sourceRead };
    if (sourceRead.state === "UNAVAILABLE") return { state: "UNAVAILABLE", snapshot: null, code: "SOURCE_UNAVAILABLE", sourceRead };
    if (sourceRead.state === "ERROR") return { state: "FAILED", snapshot: null, code: "SOURCE_ERROR", sourceRead };
    if (input.signal?.aborted) return { state: "UNAVAILABLE", snapshot: null, code: "SOURCE_UNAVAILABLE", sourceRead };

    let snapshot;
    try {
      snapshot = materializeProfileSnapshot({ subject, backend: sourceRead.backend!, sources: sourceRead.sources, generatedAt });
      snapshot = validateProfileSnapshot(snapshot);
      // Keep the public schema validation adjacent to the immutable store boundary.
      snapshot = ProfileSnapshotV1Schema.parse(snapshot);
    } catch (error) {
      if (error instanceof ProfileMaterializationError && error.code === "SNAPSHOT_BOUND") {
        return { state: "FAILED", snapshot: null, code: "SNAPSHOT_BOUND", sourceRead };
      }
      return { state: "FAILED", snapshot: null, code: "SOURCE_ERROR", sourceRead };
    }
    if (input.signal?.aborted) return { state: "UNAVAILABLE", snapshot: null, code: "SOURCE_UNAVAILABLE", sourceRead };
    try {
      const persisted = await this.options.store.putImmutable(snapshot);
      return {
        state: persisted.snapshot.generationState,
        snapshot: persisted.snapshot,
        persistence: persisted.disposition,
        sourceRead
      };
    } catch (error) {
      if (error instanceof ProfileSnapshotConflictError) return { state: "FAILED", snapshot: null, code: "PROFILE_REVISION_CONFLICT", sourceRead };
      if (error instanceof ProfileSnapshotStoreUnavailableError) return { state: "UNAVAILABLE", snapshot: null, code: "STORE_UNAVAILABLE", sourceRead };
      if (error instanceof ProfileSnapshotCorruptionError) return { state: "FAILED", snapshot: null, code: "STORE_ERROR", sourceRead };
      return { state: "FAILED", snapshot: null, code: "STORE_ERROR", sourceRead };
    }
  }
}

function mapReadStoreFailure(error: unknown): ProfileReadOutcome {
  if (error instanceof ProfileSnapshotStoreUnavailableError) return { state: "UNAVAILABLE", snapshot: null, code: "STORE_UNAVAILABLE" };
  if (error instanceof ProfileSnapshotCorruptionError) return { state: "FAILED", snapshot: null, code: "STORE_ERROR" };
  return { state: "FAILED", snapshot: null, code: "STORE_ERROR" };
}

export function profileFailureCode(value: string): ProfileFailureCode {
  const codes: ProfileFailureCode[] = ["SOURCE_UNAVAILABLE", "SOURCE_ERROR", "SOURCE_PARTIAL", "SNAPSHOT_BOUND", "STORE_UNAVAILABLE", "STORE_ERROR", "PROFILE_REVISION_CONFLICT", "GENERATION_NOT_FOUND"];
  return codes.includes(value as ProfileFailureCode) ? value as ProfileFailureCode : "SOURCE_ERROR";
}
