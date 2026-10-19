import { managedLifecycleOwnsPid } from "./linux-lifecycle.js";
import fs from "node:fs";
import path from "node:path";
import type {
  OwnershipResult,
  ProcessInfo,
  ProcessInspectionResult,
  ProcessMetadata
} from "./types.js";
import { commandLineContainsPath, pathsEqual } from "./paths.js";

export const PROCESS_METADATA_VERSION = 1 as const;

export type ProcessMetadataWriteHooks = {
  onTempWritten?: () => void;
  onRenameCompleted?: () => void;
  onCleanup?: () => void;
};

export function writeProcessMetadata(
  filePath: string,
  metadata: ProcessMetadata,
  hooks: ProcessMetadataWriteHooks = {}
): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  let committed = false;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    hooks.onTempWritten?.();
    fs.renameSync(temporaryPath, filePath);
    hooks.onRenameCompleted?.();
    committed = true;
  } finally {
    if (!committed) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Preserve the original write/rename failure.
      }
      hooks.onCleanup?.();
    }
  }
}

export function readProcessMetadata(filePath: string): ProcessMetadata | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as ProcessMetadata;
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch {
    return null;
  }
}

export function removeMetadataFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

const METADATA_IDENTITY_FIELDS: Array<keyof ProcessMetadata> = [
  "schemaVersion",
  "role",
  "pid",
  "processStartedAtUtc",
  "ownershipToken",
  "instanceId",
  "repositoryRoot",
  "stateDirectory",
  "commandMarker"
];

function metadataMatches(left: ProcessMetadata, right: ProcessMetadata): boolean {
  return METADATA_IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

/**
 * Delete metadata only when the file still contains the exact snapshot that
 * was inspected. This prevents an older refresh from deleting a new process'
 * metadata generation.
 */
export function removeProcessMetadataIfMatches(
  filePath: string,
  expectedMetadata: ProcessMetadata | null
): boolean {
  if (!expectedMetadata) return false;
  const current = readProcessMetadata(filePath);
  if (!current || !metadataMatches(current, expectedMetadata)) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

type CurrentChildEvidence = {
  pid?: number | null | undefined;
  killed?: boolean | undefined;
  exitCode?: number | null | undefined;
  signalCode?: string | null | undefined;
};

function normalizeInspection(input: {
  processInspection?: ProcessInspectionResult | null;
  processInfo?: ProcessInfo | null;
}, processId: number): ProcessInspectionResult {
  if (input.processInspection) return input.processInspection;
  if (input.processInfo) {
    return { status: "resolved", processId, info: input.processInfo };
  }
  return { status: "not-running", processId, reason: "process-not-alive" };
}

function makeResult(input: {
  status: OwnershipResult["status"];
  owned: boolean;
  processId: number;
  message: string;
  metadata: ProcessMetadata | null;
  cleanupAllowed?: boolean;
  cleanupReason?: string;
  inspection: ProcessInspectionResult | "missing";
  currentChildMatch?: boolean;
  metadataSnapshotMatch?: boolean;
}): OwnershipResult {
  const inspectionStatus = input.inspection === "missing" ? "missing" : input.inspection.status;
  const inspectionReason =
    input.inspection === "missing"
      ? null
      : input.inspection.status === "resolved"
        ? null
        : input.inspection.reason;
  const processAlive =
    input.inspection !== "missing" && input.inspection.status !== "not-running";
  const processInfoComplete =
    input.inspection !== "missing" &&
    input.inspection.status === "resolved" &&
    input.inspection.info.commandLine.length > 0;
  return {
    status: input.status,
    owned: input.owned,
    processId: input.processId,
    message: input.message,
    metadata: input.metadata,
    cleanupAllowed: input.cleanupAllowed ?? false,
    cleanupReason: input.cleanupReason ?? "unsafe-to-clean",
    processInspectionStatus: inspectionStatus,
    processInspectionReason: inspectionReason,
    processAlive,
    processInfoComplete,
    currentChildMatch: input.currentChildMatch ?? false,
    metadataSnapshotMatch: input.metadataSnapshotMatch ?? false
  };
}

/**
 * Validate ownership without trusting pid alone.
 * Mirrors scripts/lib/yuvi-process.ps1 rules + ownershipToken / instanceId.
 */
export function testProcessOwnership(input: {
  metadataPath: string;
  expectedRole: string;
  repositoryRoot: string;
  stateDirectory: string;
  ownershipToken: string;
  instanceId: string;
  processInfo?: ProcessInfo | null;
  processInspection?: ProcessInspectionResult | null;
  currentChild?: CurrentChildEvidence | null;
}): OwnershipResult {
  if (!fs.existsSync(input.metadataPath)) {
    return makeResult({
      status: "missing",
      owned: false,
      processId: 0,
      message: "metadata missing",
      metadata: null,
      inspection: "missing",
      cleanupReason: "metadata-missing"
    });
  }

  const metadata = readProcessMetadata(input.metadataPath);
  if (!metadata) {
    return makeResult({
      status: "invalid",
      owned: false,
      processId: 0,
      message: "metadata is not valid JSON",
      metadata: null,
      inspection: "missing",
      cleanupReason: "metadata-invalid"
    });
  }

  if (metadata.schemaVersion !== PROCESS_METADATA_VERSION) {
    return makeResult({
      status: "mismatch",
      owned: false,
      processId: metadata.pid ?? 0,
      message: "schema version mismatch",
      metadata,
      inspection: "missing",
      metadataSnapshotMatch: true,
      cleanupReason: "foreign-or-unsafe-metadata"
    });
  }
  if (metadata.role !== input.expectedRole) {
    return makeResult({
      status: "mismatch",
      owned: false,
      processId: metadata.pid ?? 0,
      message: "role mismatch",
      metadata,
      inspection: "missing",
      metadataSnapshotMatch: true,
      cleanupReason: "foreign-or-unsafe-metadata"
    });
  }
  if (!pathsEqual(metadata.repositoryRoot, input.repositoryRoot)) {
    return makeResult({
      status: "mismatch",
      owned: false,
      processId: metadata.pid ?? 0,
      message: "repository root mismatch",
      metadata,
      inspection: "missing",
      metadataSnapshotMatch: true,
      cleanupReason: "foreign-or-unsafe-metadata"
    });
  }
  if (!pathsEqual(metadata.stateDirectory, input.stateDirectory)) {
    return makeResult({
      status: "mismatch",
      owned: false,
      processId: metadata.pid ?? 0,
      message: "state directory mismatch",
      metadata,
      inspection: "missing",
      metadataSnapshotMatch: true,
      cleanupReason: "foreign-or-unsafe-metadata"
    });
  }
  if (
    !metadata.ownershipToken ||
    metadata.ownershipToken !== input.ownershipToken ||
    metadata.instanceId !== input.instanceId
  ) {
    return makeResult({
      status: "foreign",
      owned: false,
      processId: metadata.pid ?? 0,
      message: "ownership token / instance mismatch",
      metadata,
      inspection: "missing",
      metadataSnapshotMatch: true,
      cleanupReason: "foreign-instance"
    });
  }

  const processId = Number(metadata.pid);
  if (!Number.isInteger(processId) || processId <= 0) {
    return makeResult({
      status: "invalid",
      owned: false,
      processId: 0,
      message: "pid invalid",
      metadata,
      inspection: "missing",
      metadataSnapshotMatch: true,
      cleanupReason: "metadata-invalid"
    });
  }

  const inspection = normalizeInspection(input, processId);
  const currentChildMatch = Boolean(
    input.currentChild &&
      input.currentChild.pid === processId &&
      !input.currentChild.killed &&
      input.currentChild.exitCode == null &&
      input.currentChild.signalCode == null
  );

  if (inspection.status === "not-running") {
    return makeResult({
      status: "not-running",
      owned: false,
      processId,
      message: "process is not running",
      metadata,
      inspection,
      metadataSnapshotMatch: true,
      cleanupAllowed: true,
      cleanupReason: "process-confirmed-not-running",
      currentChildMatch
    });
  }

  if (inspection.status === "unavailable") {
    return makeResult({
      status: "unavailable",
      owned: currentChildMatch,
      processId,
      message: currentChildMatch
        ? "process identity temporarily unavailable; tracked child retained"
        : "process identity temporarily unavailable",
      metadata,
      inspection,
      metadataSnapshotMatch: true,
      cleanupReason: "identity-unavailable",
      currentChildMatch
    });
  }

  const processInfo = inspection.info;
  if (!managedLifecycleOwnsPid(processId)) return makeResult({status:"foreign",owned:false,processId,
    message:"process is outside the managed Linux lifecycle invocation",metadata,inspection});
  if (processInfo.processId !== processId) {
    return makeResult({
      status: "mismatch",
      owned: false,
      processId,
      message: "process id mismatch",
      metadata,
      inspection,
      metadataSnapshotMatch: true,
      cleanupReason: "identity-mismatch",
      currentChildMatch
    });
  }

  // The live ChildProcess handle is stronger than argv: `exec pnpm/tsx`
  // replaces the runner script in /proc/pid/cmdline but keeps the same pid.
  if (currentChildMatch) {
    return makeResult({
      status: "running",
      owned: true,
      processId,
      message: "owned process is running",
      metadata,
      inspection,
      metadataSnapshotMatch: true,
      cleanupReason: "owned-running",
      currentChildMatch
    });
  }

  const marker = metadata.commandMarker ?? "";
  if (!processInfo.commandLine) {
    return makeResult({
      status: "unavailable",
      owned: currentChildMatch,
      processId,
      message: "process identity temporarily unavailable",
      metadata,
      inspection,
      metadataSnapshotMatch: true,
      cleanupReason: "identity-unavailable",
      currentChildMatch
    });
  }
  if (!marker || !processInfo.commandLine.includes(marker)) {
    return makeResult({
      status: "mismatch",
      owned: false,
      processId,
      message: "command marker mismatch",
      metadata,
      inspection,
      metadataSnapshotMatch: true,
      cleanupReason: "marker-mismatch",
      currentChildMatch
    });
  }

  if (!commandLineContainsPath(processInfo.commandLine, input.repositoryRoot)) {
    return makeResult({
      status: "mismatch",
      owned: false,
      processId,
      message: "repository root not present in command line",
      metadata,
      inspection,
      metadataSnapshotMatch: true,
      cleanupReason: "repository-marker-mismatch",
      currentChildMatch
    });
  }

  if (processInfo.createdAtUtc && metadata.processStartedAtUtc) {
    const metaStart = Date.parse(metadata.processStartedAtUtc);
    const procStart = processInfo.createdAtUtc.getTime();
    if (Number.isFinite(metaStart) && Number.isFinite(procStart)) {
      if (Math.abs(procStart - metaStart) > 2_500) {
        return makeResult({
          status: "mismatch",
          owned: false,
          processId,
          message: "start time mismatch",
          metadata,
          inspection,
          metadataSnapshotMatch: true,
          cleanupReason: "start-time-mismatch",
          currentChildMatch
        });
      }
    }
  }

  return makeResult({
    status: "running",
    owned: true,
    processId,
    message: "owned process is running",
    metadata,
    inspection,
    metadataSnapshotMatch: true,
    cleanupReason: "owned-running",
    currentChildMatch
  });
}

export function shouldRemoveInvalidMetadata(result: OwnershipResult): boolean {
  return result.cleanupAllowed;
}
