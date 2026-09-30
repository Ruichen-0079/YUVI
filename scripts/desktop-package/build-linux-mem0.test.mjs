import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LINUX_MEM0_MANIFEST,
  LINUX_MEM0_REAL_EXE_NAME,
  linuxMem0MigrationWrapper,
  validateLinuxMem0Artifact
} from "./build-linux-mem0.mjs";

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-linux-mem0-test-"));
}

function artifact({ manifest = LINUX_MEM0_MANIFEST, files = 850, bytes = 52 * 1024 * 1024 } = {}) {
  const root = temp();
  fs.writeFileSync(path.join(root, "yuvi-mem0"), linuxMem0MigrationWrapper(), { mode: 0o755 });
  fs.writeFileSync(path.join(root, LINUX_MEM0_REAL_EXE_NAME), "ELF-placeholder", { mode: 0o755 });
  fs.mkdirSync(path.join(root, "_internal"));
  for (const file of ["base_library.zip", "libpython3.11.so.1.0", "certifi/cacert.pem", "mem0ai-2.2.1.dist-info/METADATA"]) {
    fs.mkdirSync(path.dirname(path.join(root, "_internal", file)), { recursive: true });
    fs.writeFileSync(path.join(root, "_internal", file), "fixture");
  }
  fs.writeFileSync(path.join(root, "mem0-manifest.json"), JSON.stringify(manifest));
  const each = Math.max(1, Math.ceil(bytes / files));
  for (let index = 0; index < files; index += 1) {
    fs.writeFileSync(path.join(root, `part-${index}.bin`), Buffer.alloc(each, 1));
  }
  return root;
}

test("Linux Mem0 manifest is fixed to the managed loopback contract", () => {
  assert.deepEqual(LINUX_MEM0_MANIFEST, {
    schemaVersion: 1,
    protocolVersion: 1,
    platform: "linux",
    arch: "x64",
    executable: "yuvi-mem0",
    healthPath: "/health",
    defaultHost: "127.0.0.1",
    defaultPort: 6131
  });
});

test("Linux Mem0 wrapper gates startup on the packaged Runtime migration authority", () => {
  const wrapper = linuxMem0MigrationWrapper();
  assert.match(wrapper, /YUVI_PACKAGED_MIGRATE_ONLY=1/);
  assert.match(wrapper, /DATABASE_URL="\$MEM0_PG_CONNECTION_STRING"/);
  assert.match(wrapper, /runtime\/yuvi-runtime-server\.mjs/);
  assert.match(wrapper, /exec "\$real"/);
  assert.doesNotMatch(wrapper, /pip install|pnpm|tsx/);
});

test("Linux Mem0 artifact validator accepts a complete onedir tree", () => {
  const root = artifact();
  try {
    const result = validateLinuxMem0Artifact(root);
    assert.equal(result.files < 1000, true);
    assert.equal(result.bytes > 50 * 1024 * 1024, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux Mem0 artifact rejects a Windows manifest", () => {
  const root = artifact({
    manifest: { ...LINUX_MEM0_MANIFEST, platform: "win32", executable: "yuvi-mem0.exe" }
  });
  try {
    assert.throws(() => validateLinuxMem0Artifact(root), /fixed schema/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux Mem0 artifact rejects missing migration wrapper payload", () => {
  const root = artifact();
  try {
    fs.writeFileSync(path.join(root, "yuvi-mem0"), "#!/bin/sh\nexec true\n", { mode: 0o755 });
    assert.throws(() => validateLinuxMem0Artifact(root), /migration wrapper/);
    fs.rmSync(path.join(root, LINUX_MEM0_REAL_EXE_NAME));
    assert.throws(() => validateLinuxMem0Artifact(root), /PyInstaller executable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux Mem0 artifact rejects .env and repository-path leakage", () => {
  const repoRoot = path.join(temp(), "repo-marker");
  const root = artifact();
  try {
    fs.writeFileSync(path.join(root, ".env"), "SECRET=never");
    assert.throws(() => validateLinuxMem0Artifact(root, { repoRoot }), /.env/);
    fs.rmSync(path.join(root, ".env"));
    fs.writeFileSync(path.join(root, "leak.json"), JSON.stringify({ path: repoRoot }));
    assert.throws(() => validateLinuxMem0Artifact(root, { repoRoot }), /Repository path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(repoRoot), { recursive: true, force: true });
  }
});

test("Linux Mem0 validates required runtime payload rather than platform file count", () => {
  const root = artifact();
  try {
    assert.ok(validateLinuxMem0Artifact(root).files < 1000);
    fs.rmSync(path.join(root, "_internal", "libpython3.11.so.1.0"));
    assert.throws(() => validateLinuxMem0Artifact(root), /missing libpython/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
