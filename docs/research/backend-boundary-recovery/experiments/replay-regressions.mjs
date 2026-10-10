/** Replays final assertions against one isolated version; never shares workspace package links. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
const root = resolve(process.argv[2] ?? "."),
  mode = process.argv[3] ?? "after",
  output = resolve(process.argv[4] ?? join(tmpdir(), "yuvi-regression-result.json"));
if (!["before", "after"].includes(mode))
  throw new Error("Usage: node replay-regressions.mjs CHECKOUT before|after OUTPUT_JSON");
const files = [
  "apps/server/src/routes/websocket-boundary.integration.test.ts",
  "packages/core/src/runtime-destructive-memory.test.ts",
  "packages/memory/src/destructive-boundary.test.ts",
  "apps/server/src/routes/memory-delete-outcome.test.ts",
  "apps/server/src/read-text-boundary.integration.test.ts",
  "apps/server/src/routes/websocket-ownership.integration.test.ts",
  "packages/core/src/runtime-semantic-evidence.test.ts",
  "apps/server/src/read-text-ownership.test.ts"
];
let checkout = root,
  temp;
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--conditions=development", NODE_USE_ENV_PROXY: "1" }
  });
  if (r.status !== 0) throw new Error(cmd + " failed: " + r.status);
};
try {
  if (mode === "before") {
    temp = mkdtempSync(join(tmpdir(), "yuvi-isolated-before-"));
    checkout = join(temp, "source");
    execFileSync(
      "git",
      ["worktree", "add", "--detach", checkout, "0d894cc70d42ebba0df132924f5ea181c062b431"],
      { cwd: root, stdio: "inherit" }
    );
    run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], checkout);
    run("pnpm", ["check"], checkout);
    for (const p of files) {
      mkdirSync(dirname(join(checkout, p)), { recursive: true });
      copyFileSync(join(root, p), join(checkout, p));
    }
  }
  const r = spawnSync(
    join(checkout, "node_modules/.bin/vitest"),
    [
      "run",
      ...files,
      "--maxWorkers=2",
      "--minWorkers=2",
      "--reporter=json",
      "--outputFile=" + output
    ],
    {
      cwd: checkout,
      stdio: "inherit",
      env: { ...process.env, NODE_OPTIONS: "--conditions=development" }
    }
  );
  if (mode === "after" && r.status !== 0) process.exitCode = 1;
  if (mode === "before" && r.status === 0)
    throw new Error(
      "Expected original defects were not reproduced; inspect pinned source and assertions"
    );
  console.log(
    JSON.stringify({
      version: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: checkout,
        encoding: "utf8"
      }).trim(),
      mode,
      testExitCode: r.status,
      expectedFailure: mode === "before",
      output,
      qualityEvidence: false
    })
  );
} finally {
  if (temp) {
    execFileSync("git", ["worktree", "remove", "--force", checkout], {
      cwd: root,
      stdio: "inherit"
    });
    rmSync(temp, { recursive: true, force: true });
  }
}
