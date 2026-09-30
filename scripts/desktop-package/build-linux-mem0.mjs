/** Build and validate the Linux x64 Mem0 PyInstaller onedir artifact. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { MEM0_MANIFEST_NAME, MEM0_SERVICE_ROOT, REPO_ROOT } from "./constants.mjs";
import { ensureDir } from "./paths.mjs";

export const LINUX_MEM0_EXE_NAME = "yuvi-mem0";
export const LINUX_MEM0_REAL_EXE_NAME = "yuvi-mem0.bin";
export const LINUX_MEM0_MANIFEST = Object.freeze({
  schemaVersion: 1,
  protocolVersion: 1,
  platform: "linux",
  arch: "x64",
  executable: LINUX_MEM0_EXE_NAME,
  healthPath: "/health",
  defaultHost: "127.0.0.1",
  defaultPort: 6131
});

const PYINSTALLER_VERSION = "6.13.0";
const MEM0_VERSION = "2.2.1";
const SPEC = path.join(MEM0_SERVICE_ROOT, "packaging", "yuvi_mem0.spec");

function regularFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function validatePython(candidate, spawnSyncImpl = nodeSpawnSync) {
  const probe = [
    "import importlib.metadata, json, platform, struct, sys",
    "def v(name):",
    "    try:",
    "        return importlib.metadata.version(name)",
    "    except importlib.metadata.PackageNotFoundError:",
    "        return None",
    "print(json.dumps({'platform': sys.platform, 'version': list(sys.version_info[:2]), 'pointerSize': struct.calcsize('P') * 8, 'machine': platform.machine(), 'pyinstaller': v('pyinstaller'), 'mem0ai': v('mem0ai')}))"
  ].join("\n");
  const result = spawnSyncImpl(candidate.file, [...(candidate.prefixArgs ?? []), "-c", probe], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) {
    throw new Error("Linux Mem0 Python 3.11 probe failed.");
  }
  let info;
  try {
    info = JSON.parse(String(result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1));
  } catch {
    throw new Error("Linux Mem0 Python probe returned invalid metadata.");
  }
  if (info.platform !== "linux") throw new Error("Linux Mem0 packaging requires Linux Python.");
  if (!Array.isArray(info.version) || info.version[0] !== 3 || info.version[1] !== 11) {
    throw new Error("Linux Mem0 packaging requires Python 3.11.x.");
  }
  if (
    info.pointerSize !== 64 ||
    !["X86_64", "AMD64", "X64"].includes(String(info.machine).toUpperCase())
  ) {
    throw new Error("Linux Mem0 packaging requires x64 Python.");
  }
  if (info.pyinstaller !== PYINSTALLER_VERSION) {
    throw new Error(`Linux Mem0 packaging requires PyInstaller ${PYINSTALLER_VERSION}.`);
  }
  if (info.mem0ai !== MEM0_VERSION) {
    throw new Error(`Linux Mem0 packaging requires mem0ai ${MEM0_VERSION}.`);
  }
  return info;
}

export function ensureLinuxMem0Python(options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? nodeSpawnSync;
  const env = options.env ?? process.env;
  const configured = env.YUVI_LINUX_MEM0_PYTHON?.trim() || env.YUVI_PYTHON311?.trim();
  if (configured) {
    if (!path.isAbsolute(configured) || !regularFile(configured)) {
      throw new Error(
        "YUVI_LINUX_MEM0_PYTHON must name an existing absolute Python 3.11 path."
      );
    }
    const candidate = { file: configured, prefixArgs: [] };
    validatePython(candidate, spawnSyncImpl);
    return candidate;
  }

  const venvDir = options.venvDir ?? path.join(REPO_ROOT, "build", ".mem0-linux-venv");
  const venvPython = path.join(venvDir, "bin", "python");
  if (!regularFile(venvPython)) {
    ensureDir(path.dirname(venvDir));
    const created = spawnSyncImpl("uv", ["venv", "--python", "3.11.16", venvDir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: false,
      stdio: "inherit"
    });
    if (created.error || created.status !== 0) {
      throw new Error("Unable to create the isolated Python 3.11 venv for Linux Mem0 packaging.");
    }
  }

  const installed = spawnSyncImpl(
    "uv",
    ["pip", "install", "--python", venvPython, "-e", `${MEM0_SERVICE_ROOT}[dev]`],
    { cwd: REPO_ROOT, encoding: "utf8", shell: false, stdio: "inherit" }
  );
  if (installed.error || installed.status !== 0) {
    throw new Error("Unable to install pinned Linux Mem0 packaging dependencies.");
  }
  const candidate = { file: venvPython, prefixArgs: [] };
  validatePython(candidate, spawnSyncImpl);
  return candidate;
}

export function linuxMem0MigrationWrapper() {
  return `#!/bin/sh
set -eu
self=$(readlink -f -- "$0")
mem0_dir=$(dirname -- "$self")
root=$(dirname -- "$mem0_dir")
node="$root/runtime/node"
runtime="$root/runtime/yuvi-runtime-server.mjs"
migrations="$root/runtime/migrations"
real="$mem0_dir/${LINUX_MEM0_REAL_EXE_NAME}"
[ -x "$node" ] || { echo "YUVI managed Memory: bundled Node is missing" >&2; exit 70; }
[ -f "$runtime" ] || { echo "YUVI managed Memory: packaged Runtime entry is missing" >&2; exit 70; }
[ -d "$migrations" ] || { echo "YUVI managed Memory: packaged migrations are missing" >&2; exit 70; }
[ -x "$real" ] || { echo "YUVI managed Memory: Mem0 executable is missing" >&2; exit 70; }
: "\${MEM0_PG_CONNECTION_STRING:?YUVI managed Memory requires private PostgreSQL}"
DATABASE_URL="$MEM0_PG_CONNECTION_STRING" \\
MEMORY_REPOSITORY=postgres \\
YUVI_PACKAGED=1 \\
YUVI_PACKAGED_MIGRATE_ONLY=1 \\
YUVI_RUNTIME_MIGRATIONS_DIR="$migrations" \\
"$node" "$runtime"
exec "$real"
`;
}

export function validateLinuxMem0Artifact(artifactDir, options = {}) {
  const root = path.resolve(artifactDir);
  const executable = path.join(root, LINUX_MEM0_EXE_NAME);
  const realExecutable = path.join(root, LINUX_MEM0_REAL_EXE_NAME);
  const internal = path.join(root, "_internal");
  const manifestPath = path.join(root, MEM0_MANIFEST_NAME);
  for (const [label, file] of [
    ["Linux yuvi-mem0 migration wrapper", executable],
    ["Linux yuvi-mem0 PyInstaller executable", realExecutable]
  ]) {
    if (!regularFile(file) || fs.statSync(file).size <= 0) {
      throw new Error(`${label} is missing or empty.`);
    }
  }
  const wrapper = fs.readFileSync(executable, "utf8");
  for (const marker of [
    "YUVI_PACKAGED_MIGRATE_ONLY=1",
    "MEM0_PG_CONNECTION_STRING",
    "runtime/yuvi-runtime-server.mjs",
    LINUX_MEM0_REAL_EXE_NAME
  ]) {
    if (!wrapper.includes(marker)) throw new Error(`Linux Mem0 migration wrapper is missing ${marker}.`);
  }
  if (
    !fs.existsSync(internal) ||
    !fs.statSync(internal).isDirectory() ||
    fs.readdirSync(internal).length === 0
  ) {
    throw new Error("Linux Mem0 _internal directory is missing or empty.");
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("Linux Mem0 manifest is unreadable or missing.");
  }
  if (JSON.stringify(manifest) !== JSON.stringify(LINUX_MEM0_MANIFEST)) {
    throw new Error("Linux Mem0 manifest does not match the fixed schema.");
  }

  const files = listFiles(root);
  for (const file of files) {
    const rel = path.relative(root, file).replaceAll("\\", "/");
    if (path.basename(file).toLowerCase() === ".env" || rel.toLowerCase().endsWith("/.env")) {
      throw new Error(".env was included in the Linux Mem0 artifact.");
    }
    if (
      path.extname(file).toLowerCase() === ".py" &&
      (path.basename(file).startsWith("test_") || rel.toLowerCase().includes("tests/"))
    ) {
      throw new Error("Test source was included in the Linux Mem0 artifact.");
    }
    if (options.repoRoot && /\.(json|txt|md|py|spec)$/i.test(rel)) {
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (text.includes(String(options.repoRoot))) {
        throw new Error("Repository path leaked into the Linux Mem0 artifact.");
      }
    }
  }
  const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  // PyInstaller packs pure Python into the executable; file counts vary with
  // wheel/platform layout and cannot prove completeness (released Linux has 871).
  for (const required of ["base_library.zip", "libpython3.11.so.1.0", "certifi/cacert.pem", "mem0ai-2.2.1.dist-info/METADATA"]) {
    if (!regularFile(path.join(internal, required)))
      throw new Error(`Linux Mem0 artifact is incomplete: missing ${required}.`);
  }
  if (bytes <= 50 * 1024 * 1024) {
    throw new Error("Linux Mem0 artifact is incomplete.");
  }
  return {
    artifactDir: root,
    executable,
    realExecutable,
    manifestPath,
    files: files.length,
    bytes
  };
}

export function buildLinuxPackagedMem0(options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? nodeSpawnSync;
  const python = options.python ?? ensureLinuxMem0Python(options);
  validatePython(python, options.probeSpawnSyncImpl ?? spawnSyncImpl);
  const artifactDir = path.resolve(
    options.artifactDir ?? path.join(REPO_ROOT, "build", "desktop", "linux-x64", "mem0")
  );
  const distRoot = path.dirname(artifactDir);
  const workDir = path.resolve(
    options.workDir ?? path.join(REPO_ROOT, "build", ".pyinstaller", "mem0-linux")
  );
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
  ensureDir(distRoot);
  ensureDir(path.dirname(workDir));
  const result = spawnSyncImpl(
    python.file,
    [
      ...(python.prefixArgs ?? []),
      "-m",
      "PyInstaller",
      "--noconfirm",
      "--clean",
      "--distpath",
      distRoot,
      "--workpath",
      workDir,
      SPEC
    ],
    {
      cwd: MEM0_SERVICE_ROOT,
      env: { ...process.env, YUVI_MEM0_SPEC_DIR: path.dirname(SPEC) },
      encoding: "utf8",
      shell: false,
      stdio: "inherit"
    }
  );
  if (result.error || result.status !== 0) throw new Error("Linux Mem0 packaged build failed.");

  const pyinstallerExecutable = path.join(artifactDir, LINUX_MEM0_EXE_NAME);
  const realExecutable = path.join(artifactDir, LINUX_MEM0_REAL_EXE_NAME);
  if (!regularFile(pyinstallerExecutable)) {
    throw new Error("Linux Mem0 PyInstaller executable is missing after build.");
  }
  fs.renameSync(pyinstallerExecutable, realExecutable);
  fs.writeFileSync(pyinstallerExecutable, linuxMem0MigrationWrapper(), {
    encoding: "utf8",
    mode: 0o755
  });
  fs.chmodSync(realExecutable, 0o755);
  fs.writeFileSync(
    path.join(artifactDir, MEM0_MANIFEST_NAME),
    `${JSON.stringify(LINUX_MEM0_MANIFEST, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 }
  );
  // PyInstaller's grpc hook collects SDK headers/type stubs as data. They are
  // build inputs, not runtime dependencies, and the public artifact forbids them.
  for (const file of listFiles(path.join(artifactDir, "_internal"))) {
    if ([".h", ".hpp", ".pyi"].includes(path.extname(file))) fs.unlinkSync(file);
  }
  const artifact = validateLinuxMem0Artifact(artifactDir, { repoRoot: REPO_ROOT });
  return { ...artifact, python };
}
