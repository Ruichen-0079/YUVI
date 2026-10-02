import fs from "node:fs";
import path from "node:path";
import type { Mem0Manifest } from "./types.js";

const MEM0_MANIFEST_FIELDS = new Set([
  "schemaVersion",
  "protocolVersion",
  "profileSnapshotMode",
  "platform",
  "arch",
  "executable",
  "healthPath",
  "defaultHost",
  "defaultPort"
]);

function manifestError(message: string): Error {
  return new Error(`Mem0 manifest ${message}.`);
}

export function readMem0Manifest(manifestPath: string): Mem0Manifest {
  if (!fs.existsSync(manifestPath)) {
    throw manifestError(`missing: ${manifestPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw manifestError(`invalid JSON: ${manifestPath}`);
  }
  return validateMem0Manifest(raw);
}

export function validateMem0Manifest(raw: unknown): Mem0Manifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw manifestError("must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const extra = Object.keys(obj).find((key) => !MEM0_MANIFEST_FIELDS.has(key));
  if (extra) {
    // Do not echo arbitrary manifest keys: an unexpected key could itself be
    // an environment variable name or other sensitive identifier.
    throw manifestError("contains unsupported field");
  }
  if (obj["schemaVersion"] !== 1) {
    throw manifestError("schemaVersion must be 1");
  }
  if (obj["protocolVersion"] !== 2) {
    throw manifestError("protocolVersion must be 2");
  }
  if (obj["profileSnapshotMode"] !== "bounded_snapshot") {
    throw manifestError("profileSnapshotMode must be bounded_snapshot");
  }
  const platform = obj["platform"];
  if (platform !== "win32" && platform !== "linux") {
    throw manifestError("platform must be win32 or linux");
  }
  if (obj["arch"] !== "x64") {
    throw manifestError("arch must be x64");
  }
  const executable = requireExecutable(obj["executable"]);
  if (obj["healthPath"] !== "/health") {
    throw manifestError("healthPath must be /health");
  }
  if (obj["defaultHost"] !== "127.0.0.1") {
    throw manifestError("defaultHost must be 127.0.0.1");
  }
  const defaultPort = obj["defaultPort"];
  if (
    typeof defaultPort !== "number" ||
    !Number.isInteger(defaultPort) ||
    defaultPort < 1 ||
    defaultPort > 65535
  ) {
    throw manifestError("defaultPort must be an integer between 1 and 65535");
  }
  return {
    schemaVersion: 1,
    protocolVersion: 2,
    profileSnapshotMode: "bounded_snapshot",
    platform,
    arch: "x64",
    executable,
    healthPath: "/health",
    defaultHost: "127.0.0.1",
    defaultPort
  };
}

export function resolveMem0ManifestExecutable(
  manifestPath: string,
  manifest: Mem0Manifest
): string {
  const validated = validateMem0Manifest(manifest);
  const manifestDir = path.resolve(path.dirname(manifestPath));
  const executable = path.resolve(manifestDir, validated.executable);
  const relative = path.relative(manifestDir, executable);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw manifestError("executable escapes its resource directory");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(executable);
  } catch {
    throw manifestError(`executable missing: ${executable}`);
  }
  if (!stat.isFile()) {
    throw manifestError(`executable is not a file: ${executable}`);
  }
  return executable;
}

function requireExecutable(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw manifestError("executable must be a non-empty basename");
  }
  const executable = value.trim();
  if (
    executable === "." ||
    executable === ".." ||
    executable.includes("..") ||
    executable.includes("/") ||
    executable.includes("\\") ||
    /^[A-Za-z]:/.test(executable) ||
    path.isAbsolute(executable)
  ) {
    throw manifestError("executable must be a basename");
  }
  if (path.basename(executable) !== executable) {
    throw manifestError("executable must be a basename");
  }
  return executable;
}
