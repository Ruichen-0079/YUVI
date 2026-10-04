/** Release-blocking entry: optional local tests may skip, mandatory durable tests may not. */
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateLinuxPostgresDistribution } from "../desktop-package/stage-linux-postgres.mjs";
const required = [
  "DATABASE_URL",
  "YUVI_EFFECT_TEST_DATABASE_URL",
  "YUVI_JOURNAL_TEST_DATABASE_URL",
  "YUVI_PROFILE_TEST_DATABASE_URL",
  "YUVI_POSTGRES_HOME",
  "YUVI_LINUX_POSTGRES_HOME",
  "YUVI_LINUX_MEM0_PYTHON",
  "YUVI_CONFORMANCE_ARCHIVE_ROOT"
];
for (const key of required)
  if (!process.env[key]?.trim()) throw Error(`Mandatory durable gate prerequisite missing: ${key}`);
validateLinuxPostgresDistribution(process.env.YUVI_POSTGRES_HOME);
validateLinuxPostgresDistribution(process.env.YUVI_LINUX_POSTGRES_HOME);
fs.mkdirSync(process.env.YUVI_CONFORMANCE_ARCHIVE_ROOT, { recursive: true });
const databases = [];
for (const key of required.filter((k) => k.endsWith("DATABASE_URL") || k === "DATABASE_URL")) {
  const pool = new pg.Pool({ connectionString: process.env[key] });
  try {
    const r = await pool.query(
      "select current_setting('server_version_num')::int version,current_database() database,(select default_version from pg_available_extensions where name='vector') vector"
    );
    if (r.rows[0].version < 160000 || r.rows[0].version >= 170000 || !r.rows[0].vector)
      throw Error(`PG16/pgvector required for ${key}`);
    databases.push({ variable: key, ...r.rows[0] }); // No URLs/passwords.
  } finally {
    await pool.end();
  }
}
process.env.YUVI_REQUIRE_DURABLE_CONFORMANCE = "1";
if (!process.argv.includes("--preflight-only")) {
  const report = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    databases,
    steps: [],
    pass: 0,
    skip: 0,
    fail: 1
  };
  const resultPath = path.join(process.env.YUVI_CONFORMANCE_ARCHIVE_ROOT, "gate-result.json");
  fs.writeFileSync(resultPath, JSON.stringify(report, null, 2));
  for (const [label, file, args] of [
    ["check", "pnpm", ["check"]],
    ["migration", "pnpm", ["db:migrate"]],
    ["test", "pnpm", ["test"]],
    ["packaged", process.execPath, ["scripts/conformance/packaged-linux.mjs"]]
  ]) {
    const log = fs.openSync(
      path.join(process.env.YUVI_CONFORMANCE_ARCHIVE_ROOT, `${label}.log`),
      "w"
    );
    try {
      execFileSync(file, args, { stdio: ["ignore", log, log], env: process.env });
    } finally {
      fs.closeSync(log);
    }
    report.steps.push({ label, status: "PASS" });
    if (label === "test") {
      const output = fs.readFileSync(
        path.join(process.env.YUVI_CONFORMANCE_ARCHIVE_ROOT, "test.log"),
        "utf8"
      );
      for (const match of output.matchAll(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/g)) {
        report.pass += Number(match[1]);
        report.skip += Number(match[2] ?? 0);
      }
      const nodePass = output.match(/(?:ℹ|#) pass\s+(\d+)/);
      if (!nodePass) throw Error("Missing Node packaging/fixture test summary");
      report.pass += Number(nodePass[1]);
    }
    fs.writeFileSync(resultPath, JSON.stringify(report, null, 2));
    console.log(`PASS ${label}`);
  }
  execFileSync("git", ["diff", "--check"], { stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/conformance/audit-owners.mjs"], {
    stdio: "inherit",
    env: process.env
  });
  report.fail = 0;
  fs.writeFileSync(resultPath, JSON.stringify(report, null, 2));
}
console.log("Mandatory durable conformance prerequisites verified; no PG skip fallback.");
