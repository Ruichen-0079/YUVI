/** Stage an explicit PostgreSQL 16 + pgvector distribution for Linux packaged releases. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { ensureDir } from "./paths.mjs";

const REQUIRED_TOOLS = ["postgres", "pg_ctl", "initdb", "psql"];

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

// Dereference only in-distribution links. An archive must never retain a link
// back to a build machine, or silently import a dependency from outside its root.
function copyDistribution(source, destination, boundary, parents = new Set()) {
  const real = fs.realpathSync(source);
  if (real !== boundary && !real.startsWith(boundary + path.sep)) {
    throw new Error("PostgreSQL distribution link escapes its root.");
  }
  const stat = fs.statSync(real);
  if (stat.isDirectory()) {
    if (parents.has(real)) throw new Error("PostgreSQL distribution link cycle.");
    const next = new Set(parents).add(real);
    ensureDir(destination);
    for (const name of fs.readdirSync(real)) copyDistribution(path.join(real, name), path.join(destination, name), boundary, next);
  } else if (stat.isFile()) {
    fs.copyFileSync(real, destination);
    fs.chmodSync(destination, stat.mode & 0o777);
  } else throw new Error("Unsupported PostgreSQL distribution entry.");
}

function inspectMajor(file, spawnSyncImpl) {
  const result = spawnSyncImpl(file, ["--version"], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0 || !text) {
    throw new Error(`Unable to read ${path.basename(file)} --version from Linux PostgreSQL distribution.`);
  }
  const match = text.match(/(?:PostgreSQL\)?\s+)(\d+)(?:\.\d+)?/i) ?? text.match(/\b(\d+)(?:\.\d+)?\b/);
  if (!match?.[1] || Number(match[1]) !== 16) {
    throw new Error(`Linux packaged PostgreSQL requires major 16 (${path.basename(file)} mismatch).`);
  }
  return text;
}

export function validateLinuxPostgresDistribution(root, options = {}) {
  const home = path.resolve(root);
  if (!fs.existsSync(home) || !fs.statSync(home).isDirectory()) {
    throw new Error("Linux PostgreSQL distribution root is missing.");
  }
  const binDir = path.join(home, "bin");
  const spawnSyncImpl = options.spawnSyncImpl ?? nodeSpawnSync;
  let versionText = "";
  for (const tool of REQUIRED_TOOLS) {
    const file = path.join(binDir, tool);
    if (!regularFile(file)) throw new Error(`Linux PostgreSQL distribution is missing ${tool}.`);
    const inspected = inspectMajor(file, spawnSyncImpl);
    if (tool === "postgres") versionText = inspected;
  }

  const extensionDir = path.join(home, "share", "extension");
  // Validate every extension required by the released Memory migrations.
  for (const [extension, scripts] of [["pgcrypto", ["1.3"]], ["pg_trgm", ["1.3", "1.3--1.4", "1.4--1.5", "1.5--1.6"]]]) {
    for (const file of [`${extension}.control`, ...scripts.map(version => `${extension}--${version}.sql`)]) {
      if (!regularFile(path.join(extensionDir, file))) {
        throw new Error(`Linux PostgreSQL distribution is missing ${extension} ${file}.`);
      }
    }
    if (!listFiles(path.join(home, "lib")).some(file => path.basename(file) === `${extension}.so`)) {
      throw new Error(`Linux PostgreSQL distribution is missing ${extension} ${extension}.so.`);
    }
  }
  const vectorControl = path.join(extensionDir, "vector.control");
  if (!regularFile(vectorControl)) {
    throw new Error("Linux PostgreSQL distribution is missing pgvector vector.control.");
  }
  const vectorSql = fs
    .readdirSync(extensionDir)
    .filter((name) => /^vector--.+\.sql$/i.test(name) && regularFile(path.join(extensionDir, name)))
    .sort();
  if (vectorSql.length === 0) {
    throw new Error("Linux PostgreSQL distribution is missing pgvector extension SQL.");
  }
  const vectorLibrary = listFiles(path.join(home, "lib")).find(
    (file) => path.basename(file).toLowerCase() === "vector.so"
  );
  if (!vectorLibrary) {
    throw new Error("Linux PostgreSQL distribution is missing pgvector vector.so.");
  }

  let pgvectorVersion = null;
  try {
    const control = fs.readFileSync(vectorControl, "utf8");
    pgvectorVersion = control.match(/^default_version\s*=\s*['\"]([^'\"]+)['\"]/m)?.[1] ?? null;
  } catch {
    pgvectorVersion = null;
  }
  return {
    home,
    versionText,
    postgresMajor: 16,
    pgvectorVersion,
    vectorControl,
    vectorLibrary,
    vectorSql
  };
}

export function stageLinuxPostgresDistribution(options = {}) {
  const sourceRaw = options.sourceRoot ?? (options.env ?? process.env).YUVI_LINUX_POSTGRES_HOME?.trim();
  if (!sourceRaw) {
    throw new Error("YUVI_LINUX_POSTGRES_HOME is required to build a managed Linux release.");
  }
  const source = path.resolve(sourceRaw);
  const destination = path.resolve(options.destination);
  if (source === destination || destination.startsWith(source + path.sep)) {
    throw new Error("Linux PostgreSQL staging destination must be separate from the source distribution.");
  }
  const validated = validateLinuxPostgresDistribution(source, options);
  fs.rmSync(destination, { recursive: true, force: true });
  ensureDir(path.dirname(destination));
  copyDistribution(source, destination, fs.realpathSync(source));
  const staged = validateLinuxPostgresDistribution(destination, options);
  fs.writeFileSync(
    path.join(destination, "yuvi-postgres-distribution.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        platform: "linux",
        arch: "x64",
        postgresMajor: 16,
        postgresVersion: staged.versionText,
        pgvectorVersion: staged.pgvectorVersion
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return validated;
}
