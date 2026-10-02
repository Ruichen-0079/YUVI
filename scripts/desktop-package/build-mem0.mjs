/** Build and validate the Windows x64 Mem0 PyInstaller onedir artifact. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  MEM0_BUILD_SCRIPT,
  MEM0_EXE_NAME,
  MEM0_INTERNAL_DIR_NAME,
  MEM0_MANIFEST_NAME,
  MEM0_OUT_DIR,
  MEM0_SERVICE_ROOT,
  REPO_ROOT
} from "./constants.mjs";

export const MEM0_MANIFEST = Object.freeze({
  schemaVersion: 1,
  protocolVersion: 2,
  profileSnapshotMode: "bounded_snapshot",
  platform: "win32",
  arch: "x64",
  executable: MEM0_EXE_NAME,
  healthPath: "/health",
  defaultHost: "127.0.0.1",
  defaultPort: 6131
});

const PYTHON_PROBE = [
  "import importlib.metadata, json, platform, struct, sys",
  "def v(name):",
  "    try:",
  "        return importlib.metadata.version(name)",
  "    except importlib.metadata.PackageNotFoundError:",
  "        return None",
  "print(json.dumps({'platform': sys.platform, 'version': list(sys.version_info[:2]), 'pointerSize': struct.calcsize('P') * 8, 'machine': platform.machine(), 'pyinstaller': v('pyinstaller'), 'mem0ai': v('mem0ai')}))"
].join("\n");

function spawnResult(candidate, args, spawnSyncImpl = nodeSpawnSync) {
  const result = spawnSyncImpl(candidate.file, [...(candidate.prefixArgs ?? []), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error)
    throw new Error(`Python 3.11 probe failed (${safeInterpreterLabel(candidate.file)}).`);
  return result;
}

function safeInterpreterLabel(file) {
  return path.win32.basename(String(file).replaceAll("/", "\\"));
}

function assertCandidate(candidate) {
  if (!candidate || typeof candidate.file !== "string" || !candidate.file.trim()) {
    throw new Error("Python 3.11 interpreter candidate is invalid.");
  }
  if (
    !Array.isArray(candidate.prefixArgs) ||
    candidate.prefixArgs.some((arg) => typeof arg !== "string")
  ) {
    throw new Error("Python 3.11 interpreter arguments are invalid.");
  }
  if (candidate.prefixArgs.some((arg) => /[;&|<>]/.test(arg))) {
    throw new Error("Python 3.11 interpreter arguments contain shell syntax.");
  }
}

/** Validate an interpreter by executing it and reading a single JSON probe line. */
export function validatePython311(candidate, options = {}) {
  assertCandidate(candidate);
  const result = spawnResult(candidate, ["-c", PYTHON_PROBE], options.spawnSyncImpl);
  if (result.status !== 0) {
    throw new Error(`Python 3.11 probe failed (${safeInterpreterLabel(candidate.file)}).`);
  }
  let info;
  try {
    info = JSON.parse(
      String(result.stdout ?? "")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .at(-1)
    );
  } catch {
    throw new Error("Python 3.11 probe returned invalid version metadata.");
  }
  if (info.platform !== "win32") throw new Error("Mem0 packaged build requires Windows Python.");
  if (!Array.isArray(info.version) || info.version[0] !== 3 || info.version[1] !== 11) {
    throw new Error("Mem0 packaged build requires Python 3.11.x.");
  }
  if (info.pointerSize !== 64) throw new Error("Mem0 packaged build requires 64-bit Python.");
  if (!["AMD64", "X86_64"].includes(String(info.machine).toUpperCase())) {
    throw new Error("Mem0 packaged build requires Windows x64 Python.");
  }
  if (info.pyinstaller !== "6.13.0") {
    throw new Error(
      `PyInstaller 6.13.0 is required (detected ${String(info.pyinstaller ?? "missing")}).`
    );
  }
  if (info.mem0ai !== "2.2.1") {
    throw new Error(`mem0ai 2.2.1 is required (detected ${String(info.mem0ai ?? "missing")}).`);
  }
  return {
    ...info,
    python: `3.${info.version[1]}`,
    interpreterCategory: candidate.prefixArgs?.length ? "py-launcher-3.11" : "python311"
  };
}

function regularFile(filePath, fsImpl = fs) {
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Resolve only an explicit Python 3.11, the project venv, or py -3.11. */
export function resolvePython311(options = {}) {
  const env = options.env ?? process.env;
  const fsImpl = options.fsImpl ?? fs;
  const spawnSyncImpl = options.spawnSyncImpl ?? nodeSpawnSync;
  const configured = typeof env.YUVI_PYTHON311 === "string" ? env.YUVI_PYTHON311.trim() : "";
  if (configured) {
    if (
      !path.isAbsolute(configured) ||
      /[;&|<>]/.test(configured) ||
      /\s+[-/]{1,2}\w/.test(configured)
    ) {
      throw new Error(
        "YUVI_PYTHON311 must be an absolute interpreter path without shell arguments."
      );
    }
    if (!regularFile(configured, fsImpl)) {
      throw new Error(`YUVI_PYTHON311 interpreter is missing (${path.basename(configured)}).`);
    }
    const candidate = { file: configured, prefixArgs: [] };
    validatePython311(candidate, { spawnSyncImpl });
    return candidate;
  }

  const venv = path.join(
    options.serviceRoot ?? MEM0_SERVICE_ROOT,
    ".venv",
    "Scripts",
    "python.exe"
  );
  if (regularFile(venv, fsImpl)) {
    const candidate = { file: venv, prefixArgs: [] };
    validatePython311(candidate, { spawnSyncImpl });
    return candidate;
  }

  const candidate = { file: "py.exe", prefixArgs: ["-3.11"] };
  try {
    validatePython311(candidate, { spawnSyncImpl });
  } catch {
    throw new Error(
      "Python 3.11 is unavailable; set YUVI_PYTHON311 or install the py -3.11 launcher."
    );
  }
  return candidate;
}

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Validate the strict, self-contained Mem0 onedir artifact. */
export function validateMem0Artifact(artifactDir, options = {}) {
  const root = path.resolve(artifactDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
    throw new Error("Mem0 artifact directory is missing.");
  const executable = path.join(root, MEM0_EXE_NAME);
  const internal = path.join(root, MEM0_INTERNAL_DIR_NAME);
  const manifestPath = path.join(root, MEM0_MANIFEST_NAME);
  if (!regularFile(executable) || fs.statSync(executable).size <= 0)
    throw new Error("yuvi-mem0.exe is missing or empty.");
  if (
    !fs.existsSync(internal) ||
    !fs.statSync(internal).isDirectory() ||
    fs.readdirSync(internal).length === 0
  ) {
    throw new Error("Mem0 _internal directory is missing or empty.");
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("mem0-manifest.json is unreadable or missing.");
  }
  if (JSON.stringify(manifest) !== JSON.stringify(MEM0_MANIFEST))
    throw new Error("Mem0 manifest does not match the fixed schema.");
  const manifestText = JSON.stringify(manifest);
  if (
    path.isAbsolute(manifestText) ||
    /[A-Za-z]:[\\/]/.test(manifestText) ||
    /(?:api[_-]?key|database[_-]?url|secret|password|token)/i.test(manifestText)
  ) {
    throw new Error("Mem0 manifest contains an unsafe path or secret-like field.");
  }
  const files = listFiles(root);
  for (const file of files) {
    const rel = path.relative(root, file).replaceAll("\\", "/");
    if (path.basename(file).toLowerCase() === ".env" || rel.toLowerCase().endsWith("/.env"))
      throw new Error(".env was included in the Mem0 artifact.");
    if (
      path.extname(file).toLowerCase() === ".py" &&
      (path.basename(file).startsWith("test_") || rel.toLowerCase().includes("tests/"))
    )
      throw new Error("Test source was included in the Mem0 artifact.");
    if (
      options.repoRoot &&
      fs.readFileSync(file).toString("utf8").includes(String(options.repoRoot))
    )
      throw new Error("Repository path leaked into the Mem0 artifact.");
  }
  const totalBytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  if (files.length <= 1000)
    throw new Error(`Mem0 artifact is incomplete (only ${files.length} files).`);
  if (totalBytes <= 50 * 1024 * 1024)
    throw new Error("Mem0 artifact is incomplete (smaller than 50 MB).");
  return {
    artifactDir: root,
    executable,
    manifestPath,
    internalDir: internal,
    files: files.length,
    bytes: totalBytes
  };
}

export function buildPackagedMem0(options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? nodeSpawnSync;
  const candidate = options.python ?? resolvePython311(options);
  const scriptPath = options.buildScript ?? MEM0_BUILD_SCRIPT;
  const artifactDir = options.artifactDir ?? MEM0_OUT_DIR;
  const result = spawnSyncImpl(candidate.file, [...(candidate.prefixArgs ?? []), scriptPath], {
    cwd: REPO_ROOT,
    shell: false,
    windowsHide: true,
    stdio: "inherit"
  });
  if (result.error || result.status !== 0) throw new Error("Mem0 packaged build failed.");
  const artifact = validateMem0Artifact(artifactDir, { repoRoot: REPO_ROOT });
  return { ...artifact, python: candidate, buildScript: scriptPath };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("build-mem0.mjs");
if (isMain) {
  try {
    const result = buildPackagedMem0();
    console.info(`[desktop-package] Mem0 artifact: ${result.files} files, ${result.bytes} bytes`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
