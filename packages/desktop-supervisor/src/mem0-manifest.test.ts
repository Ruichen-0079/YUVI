import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readMem0Manifest,
  resolveMem0ManifestExecutable,
  validateMem0Manifest
} from "./mem0-manifest.js";
import type { Mem0Manifest } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function validManifest(): Mem0Manifest {
  return {
    schemaVersion: 1,
    protocolVersion: 2,
    profileSnapshotMode: "bounded_snapshot",
    platform: "win32",
    arch: "x64",
    executable: "yuvi-mem0.exe",
    healthPath: "/health",
    defaultHost: "127.0.0.1",
    defaultPort: 6131
  };
}

function fixture(): { dir: string; manifestPath: string; executable: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-mem0-manifest-"));
  tempDirs.push(dir);
  const executable = path.join(dir, "yuvi-mem0.exe");
  const manifestPath = path.join(dir, "mem0-manifest.json");
  fs.writeFileSync(executable, "MZ");
  fs.writeFileSync(manifestPath, JSON.stringify(validManifest()));
  return { dir, manifestPath, executable };
}

describe("Mem0 manifest", () => {
  it("accepts the fixed Windows manifest and resolves its executable", () => {
    const tree = fixture();
    expect(readMem0Manifest(tree.manifestPath)).toEqual(validManifest());
    expect(resolveMem0ManifestExecutable(tree.manifestPath, validManifest())).toBe(tree.executable);
  });

  it("accepts the fixed Linux x64 manifest", () => {
    expect(
      validateMem0Manifest({
        ...validManifest(),
        platform: "linux",
        executable: "yuvi-mem0"
      })
    ).toEqual({
      ...validManifest(),
      platform: "linux",
      executable: "yuvi-mem0"
    });
  });

  it("rejects packaged Mem0 artifacts that do not declare bounded snapshot support", () => {
    const tree = fixture();
    const oldManifest = { ...validManifest(), protocolVersion: 1 } as Record<string, unknown>;
    delete oldManifest["profileSnapshotMode"];
    fs.writeFileSync(tree.manifestPath, JSON.stringify(oldManifest));
    expect(() => readMem0Manifest(tree.manifestPath)).toThrow(/protocolVersion must be 2/i);
  });

  it("rejects missing and invalid JSON files", () => {
    const tree = fixture();
    expect(() => readMem0Manifest(path.join(tree.dir, "missing.json"))).toThrow(
      /manifest missing/i
    );
    fs.writeFileSync(tree.manifestPath, "not json");
    expect(() => readMem0Manifest(tree.manifestPath)).toThrow(/invalid json/i);
  });

  it.each([
    [null, "object"],
    [[], "object"],
    [{ ...validManifest(), schemaVersion: 2 }, "schemaVersion"],
    [{ ...validManifest(), protocolVersion: 1 }, "protocolVersion"],
    [{ ...validManifest(), profileSnapshotMode: "unsupported" }, "profileSnapshotMode"],
    [{ ...validManifest(), platform: "darwin" }, "platform"],
    [{ ...validManifest(), arch: "arm64" }, "arch"],
    [{ ...validManifest(), healthPath: "/status" }, "healthPath"],
    [{ ...validManifest(), defaultHost: "0.0.0.0" }, "defaultHost"],
    [{ ...validManifest(), defaultPort: 0 }, "defaultPort"],
    [{ ...validManifest(), defaultPort: -1 }, "defaultPort"],
    [{ ...validManifest(), defaultPort: 65536 }, "defaultPort"],
    [{ ...validManifest(), defaultPort: 6131.5 }, "defaultPort"],
    [{ ...validManifest(), extra: "secret-value" }, "unsupported field"]
  ])("rejects invalid manifest shape (%s)", (raw, message) => {
    expect(() => validateMem0Manifest(raw)).toThrow(new RegExp(message, "i"));
    expect(() => validateMem0Manifest(raw)).not.toThrow(/secret-value/);
  });

  it.each([
    "",
    "C:\\Windows\\system32\\yuvi-mem0.exe",
    "../yuvi-mem0.exe",
    "nested/yuvi-mem0.exe",
    "nested\\yuvi-mem0.exe"
  ])("rejects executable %s", (executable) => {
    expect(() => validateMem0Manifest({ ...validManifest(), executable })).toThrow(/basename/i);
  });

  it("rejects a missing executable and a directory executable", () => {
    const tree = fixture();
    fs.rmSync(tree.executable);
    expect(() => resolveMem0ManifestExecutable(tree.manifestPath, validManifest())).toThrow(
      /executable missing/i
    );
    fs.mkdirSync(tree.executable);
    expect(() => resolveMem0ManifestExecutable(tree.manifestPath, validManifest())).toThrow(
      /not a file/i
    );
  });

  it("never includes manifest contents or secrets in validation errors", () => {
    try {
      validateMem0Manifest({ ...validManifest(), extra: "P3_SECRET" });
      throw new Error("expected manifest validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/unsupported field/i);
      expect((error as Error).message).not.toContain("P3_SECRET");
    }
  });
});
