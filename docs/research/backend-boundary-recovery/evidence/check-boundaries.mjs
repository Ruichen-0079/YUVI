import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? resolve(here, "../../../.."));
const old = resolve(root, "docs/research/backend-completeness-audit/evidence");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const ledger = read(resolve(here, "high-risk-boundary-ledger.json"));
const dis = read(resolve(here, "candidate-disambiguation.json"));
const errors = [];
const assert = (b, m) => {
  if (!b) errors.push(m);
};
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
for (const [file, digest] of Object.entries(ledger.inputDigests))
  assert(sha(resolve(old, file)) === digest, `Pinned input changed: ${file}`);
assert(git("rev-parse", ledger.baselineSHA) === ledger.baselineSHA, "Invalid baseline");
const inventory = read(resolve(old, "source-inventory.json"));
const prod = inventory.files.filter((f) => f.production).map((f) => f.gitPath);
assert(
  git("diff", "--name-only", inventory.baselineSHA, ledger.baselineSHA, "--", ...prod) === "",
  "Prior production graph is not byte-identical to baseline"
);
for (const [p, blob] of Object.entries({ ...ledger.sourceBlobs, ...ledger.testBlobs }))
  assert(git("hash-object", p) === blob, `Production source changed; rebuild ledger: ${p}`);
const maps = [
  ["A", "entrypoint-traces.json", "entries"],
  ["B", "producer-consumer-graph.json", "states"],
  ["C", "data-transformation-boundaries.json", "candidates"]
];
for (const [pass, file, key] of maps) {
  const source = read(resolve(old, file))
    [key].map((x) => x.id)
    .sort();
  const recorded = dis.records
    .filter((x) => x.pass === pass)
    .map((x) => x.originalID)
    .sort();
  assert(
    JSON.stringify(source) === JSON.stringify(recorded),
    `Lost or duplicated ${pass} candidate IDs`
  );
}
assert(
  JSON.stringify(
    read(resolve(old, "cross-pass-discrepancies.json"))
      .discrepancies.map((x) => x.id)
      .sort()
  ) === JSON.stringify(dis.gaps.map((x) => x.originalID).sort()),
  "Lost or duplicated original gaps"
);
const ids = new Set(ledger.boundaries.map((x) => x.id));
assert(ids.size === ledger.boundaries.length, "Duplicate boundary IDs");
for (const x of dis.records)
  for (const id of x.boundaryIDs) assert(ids.has(id), `Unknown boundary ${id}`);
const statuses = ["VERIFIED", "DEFECT_CONFIRMED", "MITIGATED", "OPEN_WITH_REASON"];
for (const x of ledger.boundaries) {
  assert(statuses.includes(x.conclusion), `Unknown conclusion ${x.id}`);
  for (const k of [
    "producer",
    "consumer",
    "entryAndActivation",
    "structures",
    "allowedDomainAndUnits",
    "failureAndCancellation",
    "lifecycleOwner",
    "staticEvidence",
    "positiveTests",
    "negativeTests",
    "uncoveredConditions"
  ])
    assert(k in x, `Missing ${k}: ${x.id}`);
  for (const p of [...(x.paths ?? []), ...x.positiveTests, ...x.negativeTests])
    assert(existsSync(resolve(root, p)), `Missing reviewed source/test ${p}`);
  if (["MITIGATED", "VERIFIED"].includes(x.conclusion))
    assert(
      x.positiveTests.length > 0 && x.negativeTests.length > 0,
      `No positive/negative evidence ${x.id}`
    );
}
const counts = (xs) =>
  Object.fromEntries([...new Set(xs)].sort().map((k) => [k, xs.filter((x) => x === k).length]));
const reports = {};
for (const x of ledger.boundaries.filter((x) => x.boundaryClass === "CONFIRMED_PRODUCTION_CHAIN"))
  for (const name of x.counterfactualTests ?? []) {
    const p = resolve(here, name);
    assert(existsSync(p), `Missing probe result ${name}`);
    if (existsSync(p)) {
      const r = read(p);
      reports[name] = {
        passed: r.numPassedTests,
        failed: r.numFailedTests,
        skipped: r.numPendingTests
      };
    }
  }
const cross = resolve(here, "cross-package-regression-final.json");
if (existsSync(cross)) {
  const r = read(cross);
  reports.crossPackage = {
    passed: r.numPassedTests,
    failed: r.numFailedTests,
    skipped: r.numPendingTests
  };
  assert(r.success && r.numFailedTests === 0, "Cross-package regression failed");
}
const ranges = {};
for (const category of [
  "EXTERNAL_ENTRY",
  "MODEL_IO",
  "PERSISTENT_STATE",
  "AUTHORIZED_EFFECT",
  "CROSS_PROCESS_PROVIDER",
  "ASYNC_OWNERSHIP"
]) {
  const all = ledger.boundaries.filter((r) => r.categories.includes(category));
  const actual = all.filter((r) =>
    ["CONFIRMED_PRODUCTION_CHAIN", "CONFIRMED_REGISTRATION"].includes(r.boundaryClass)
  );
  ranges[category] = {
    indexed: all.length,
    confirmedRegistrationsOrReviewedChains: actual.length,
    confirmedConclusions: counts(actual.map((r) => r.conclusion)),
    wiringUnresolvedCandidates: all.length - actual.length,
    completeEnumeration: false
  };
}
const sample = read(resolve(here, "residual-sample.json"));
const summary = {
  baselineSHA: ledger.baselineSHA,
  graphSourceSHA: ledger.graphSourceSHA,
  reviewedProductionSHA: ledger.reviewedProductionSHA,
  rawUniverse: dis.rawCounts,
  originalIDsPreserved: true,
  oldGapDispositions: counts(dis.gaps.map((x) => x.disposition)),
  ledgerRows: ledger.boundaries.length,
  classes: counts(ledger.boundaries.map((x) => x.boundaryClass)),
  conclusions: counts(ledger.boundaries.map((x) => x.conclusion)),
  sixRanges: ranges,
  probeReports: reports,
  sampling: {
    seed: sample.seed,
    total: sample.samples.length,
    statuses: counts(sample.samples.map((x) => x.review))
  },
  realModelEvidence: {
    actualCalls: 0,
    status: "NOT_RUN_NO_APPLICATION_CREDENTIALS",
    harness: "../experiments/run-live-model.mjs"
  },
  openReasons: ledger.enumerationLimitations,
  excludedAreas: [
    "Independent Plunge and desktop-presentation versions not modified or claimed covered",
    "No native/device/remote-provider quality or PostgreSQL restart evidence"
  ],
  validationErrors: errors,
  scopeComplete: false,
  interpretation:
    "Checks inventory preservation and stale evidence, not correctness or semantic completeness. OPEN rows never count as verified."
};
writeFileSync(
  resolve(here, "boundary-coverage-summary.json"),
  JSON.stringify(summary, null, 2) + "\n"
);
console.log(JSON.stringify({ errors, ranges, scopeComplete: false }, null, 2));
if (errors.length) process.exitCode = 1;
