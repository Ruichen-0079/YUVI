import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MEM0_MANIFEST,
  buildPackagedMem0,
  validateMem0Artifact,
  validatePython311,
  resolvePython311
} from "./build-mem0.mjs";

const probe = (overrides = {}) => ({
  status: 0,
  stdout: JSON.stringify({
    platform: "win32",
    version: [3, 11],
    pointerSize: 64,
    machine: "AMD64",
    pyinstaller: "6.13.0",
    mem0ai: "2.2.1",
    ...overrides
  }),
  stderr: ""
});

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-mem0-test-"));
}

function artifact({
  files = 1001,
  bytes = 52 * 1024 * 1024,
  manifest = MEM0_MANIFEST,
  internal = true
} = {}) {
  const root = temp();
  fs.writeFileSync(path.join(root, "yuvi-mem0.exe"), "MZ");
  if (internal) {
    fs.mkdirSync(path.join(root, "_internal"));
    fs.writeFileSync(path.join(root, "_internal", "placeholder.dat"), "x");
  }
  fs.writeFileSync(path.join(root, "mem0-manifest.json"), JSON.stringify(manifest));
  const each = Math.max(1, Math.ceil(bytes / files));
  for (let i = 0; i < files; i += 1)
    fs.writeFileSync(path.join(root, `part-${i}.bin`), Buffer.alloc(each, 1));
  return root;
}

test("explicit YUVI_PYTHON311 has highest priority", () => {
  const dir = temp();
  const explicit = path.join(dir, "python.exe");
  const venv = path.join(dir, ".venv", "Scripts", "python.exe");
  fs.writeFileSync(explicit, "x");
  fs.mkdirSync(path.dirname(venv), { recursive: true });
  fs.writeFileSync(venv, "x");
  const spawn = () => probe();
  const result = resolvePython311({
    env: { YUVI_PYTHON311: explicit },
    serviceRoot: dir,
    spawnSyncImpl: spawn
  });
  assert.equal(result.file, explicit);
});

test("project venv is selected before py launcher", () => {
  const dir = temp();
  const venv = path.join(dir, ".venv", "Scripts", "python.exe");
  fs.mkdirSync(path.dirname(venv), { recursive: true });
  fs.writeFileSync(venv, "x");
  const result = resolvePython311({ env: {}, serviceRoot: dir, spawnSyncImpl: () => probe() });
  assert.equal(result.file, venv);
});

test("py launcher is represented with -3.11", () => {
  const result = resolvePython311({ env: {}, serviceRoot: temp(), spawnSyncImpl: () => probe() });
  assert.deepEqual(result, { file: "py.exe", prefixArgs: ["-3.11"] });
});

test("explicit interpreter rejects shell arguments", () => {
  assert.throws(
    () => resolvePython311({ env: { YUVI_PYTHON311: "C:\\Python311\\python.exe --version" } }),
    /absolute interpreter path/
  );
});

for (const [name, overrides, message] of [
  ["rejects Python 3.13", { version: [3, 13] }, /3\.11/],
  ["rejects non-Windows", { platform: "linux" }, /Windows/],
  ["rejects 32-bit", { pointerSize: 32 }, /64-bit/],
  ["rejects non-AMD64", { machine: "ARM64" }, /x64/],
  ["rejects wrong PyInstaller", { pyinstaller: "6.12.0" }, /PyInstaller/],
  ["rejects wrong mem0ai", { mem0ai: "0.1.106" }, /mem0ai/]
]) {
  test(name, () =>
    assert.throws(
      () =>
        validatePython311(
          { file: "py.exe", prefixArgs: ["-3.11"] },
          { spawnSyncImpl: () => probe(overrides) }
        ),
      message
    )
  );
}

test("artifact validator accepts the fixed manifest and complete tree", () => {
  const root = artifact();
  const result = validateMem0Artifact(root);
  assert.equal(result.files > 1000, true);
  assert.equal(result.bytes > 50 * 1024 * 1024, true);
});

test("artifact validator rejects extra manifest fields", () => {
  const root = artifact({ manifest: { ...MEM0_MANIFEST, extra: true }, files: 1, bytes: 1 });
  assert.throws(() => validateMem0Artifact(root), /fixed schema/);
});

test("artifact validator rejects manifest paths", () => {
  const root = artifact({
    manifest: { ...MEM0_MANIFEST, executable: "C:\\temp\\yuvi-mem0.exe" },
    files: 1,
    bytes: 1
  });
  assert.throws(() => validateMem0Artifact(root), /fixed schema/);
});

test("artifact validator rejects missing executable", () => {
  const root = artifact({ files: 1, bytes: 1 });
  fs.rmSync(path.join(root, "yuvi-mem0.exe"));
  assert.throws(() => validateMem0Artifact(root), /missing|empty/);
});

test("artifact validator rejects empty executable", () => {
  const root = artifact({ files: 1, bytes: 1 });
  fs.writeFileSync(path.join(root, "yuvi-mem0.exe"), "");
  assert.throws(() => validateMem0Artifact(root), /missing|empty/);
});

test("artifact validator rejects missing internal directory", () => {
  const root = artifact({ files: 1, bytes: 1, internal: false });
  assert.throws(() => validateMem0Artifact(root), /_internal/);
});

test("artifact validator rejects empty internal directory", () => {
  const root = artifact({ files: 1, bytes: 1 });
  fs.rmSync(path.join(root, "_internal"), { recursive: true });
  fs.mkdirSync(path.join(root, "_internal"));
  assert.throws(() => validateMem0Artifact(root), /_internal/);
});

test("artifact validator rejects .env", () => {
  const root = artifact({ files: 1, bytes: 1 });
  fs.writeFileSync(path.join(root, ".env"), "SECRET=x");
  assert.throws(() => validateMem0Artifact(root), /.env/);
});

test("artifact validator rejects incomplete file count", () => {
  const root = artifact({ files: 10, bytes: 1024 });
  assert.throws(() => validateMem0Artifact(root), /incomplete/);
});

test("artifact validator rejects incomplete total size", () => {
  const root = artifact({ files: 1001, bytes: 1024 });
  assert.throws(() => validateMem0Artifact(root), /incomplete/);
});

test("artifact validator rejects repository path leakage", () => {
  const repoRoot = path.join(temp(), "repo-root");
  const root = artifact({ files: 1, bytes: 1 });
  fs.writeFileSync(path.join(root, "leak.json"), `${repoRoot}\\secret`);
  assert.throws(() => validateMem0Artifact(root, { repoRoot }), /Repository path/);
});

test("validation errors do not echo secret values", () => {
  const secret = "P3_MEM0_SECRET_NEVER_LOG";
  const root = artifact({ manifest: { ...MEM0_MANIFEST, secret }, files: 1, bytes: 1 });
  assert.throws(
    () => validateMem0Artifact(root),
    (error) => !String(error).includes(secret)
  );
});

test("probe errors do not echo environment secrets", () => {
  const secret = "P3_MEM0_SECRET_NEVER_LOG";
  assert.throws(
    () =>
      validatePython311(
        { file: `C:\\${secret}\\python.exe`, prefixArgs: [] },
        { spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: secret }) }
      ),
    (error) => !String(error).includes(secret)
  );
});

test("build invokes the selected interpreter with the repository build script", () => {
  const root = artifact();
  const calls = [];
  const result = buildPackagedMem0({
    python: { file: "python.exe", prefixArgs: ["-3.11"] },
    artifactDir: root,
    buildScript: path.join(temp(), "services", "memory-mem0", "packaging", "build.py"),
    spawnSyncImpl: (file, args, options) => {
      calls.push({ file, args, options });
      return { status: 0 };
    }
  });
  assert.equal(calls[0].file, "python.exe");
  assert.deepEqual(calls[0].args.slice(0, 1), ["-3.11"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].args.at(-1).endsWith("build.py"), true);
  assert.equal(result.files > 1000, true);
});
