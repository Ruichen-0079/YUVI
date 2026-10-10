import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(here, "../../../.."));
const temp = mkdtempSync(join(tmpdir(), "yuvi-checker-"));
const outcomes = [];
try {
  cpSync(here, temp, { recursive: true });
  const checker = join(temp, "check-boundaries.mjs");
  const run = () => spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
  assert.equal(run().status, 0);
  outcomes.push({ case: "unchanged pinned inputs", status: "PASS" });
  const original = readFileSync(join(temp, "candidate-disambiguation.json"), "utf8");
  const changed = JSON.parse(original);
  changed.records.pop();
  writeFileSync(join(temp, "candidate-disambiguation.json"), JSON.stringify(changed));
  assert.equal(run().status, 1);
  outcomes.push({ case: "removed original candidate", status: "REJECTED" });
  writeFileSync(join(temp, "candidate-disambiguation.json"), original);
  const f = join(temp, "high-risk-boundary-ledger.json");
  const ledger = JSON.parse(readFileSync(f, "utf8"));
  const p = Object.keys(ledger.sourceBlobs)[0];
  ledger.sourceBlobs[p] = "0".repeat(40);
  writeFileSync(f, JSON.stringify(ledger));
  assert.equal(run().status, 1);
  outcomes.push({ case: "stale source blob", status: "REJECTED" });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
writeFileSync(
  join(here, "checker-self-test-results.json"),
  JSON.stringify({ outcomes, productionMutations: 0 }, null, 2) + "\n"
);
