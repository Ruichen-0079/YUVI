import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const runtime = fs.readFileSync(
  new URL("../yuvi-runtime-server.packaged.mts", import.meta.url),
  "utf8"
);
const supervisor = fs.readFileSync(
  new URL("../yuvi-desktop-supervisor.packaged.mjs", import.meta.url),
  "utf8"
);
const rustBoot = fs.readFileSync(
  new URL("../../apps/desktop/src-tauri/src/durable_memory_boot.rs", import.meta.url),
  "utf8"
);

test("packaged Runtime exposes migration-only mode without a second migration implementation", () => {
  assert.match(runtime, /YUVI_PACKAGED_MIGRATE_ONLY/);
  assert.match(runtime, /await preparePackagedPostgres\(\)/);
  assert.match(runtime, /runPostgresMigrations/);
  assert.doesNotMatch(runtime, /postgres-migrations\.ts/);
});

test("packaged Supervisor waits for Tauri product bootstrap before services start", () => {
  assert.match(supervisor, /supervisor\.awaiting-product-bootstrap/);
  const packagedGate = supervisor.indexOf('if (mode === "packaged")');
  const developmentBootstrap = supervisor.indexOf("void supervisor.bootstrap()", packagedGate);
  assert.ok(packagedGate >= 0 && developmentBootstrap > packagedGate);
  assert.match(supervisor, /} else \{\n    void supervisor\.bootstrap\(\)/);
});

test("Tauri staged boot orders PostgreSQL then Mem0 then Runtime without constructing database URLs", () => {
  const pg = rustBoot.indexOf('start_service(app, "postgres")');
  const mem0 = rustBoot.indexOf('start_service(app, "mem0")');
  const runtimeStart = rustBoot.indexOf('start_service(app, "runtime")');
  assert.ok(pg >= 0 && mem0 > pg && runtimeStart > mem0);
  assert.match(rustBoot, /ensure_private_postgres_password/);
  assert.match(rustBoot, /YUVI_POSTGRES_MODE/);
  // R5 must inspect whether the user already configured an external database
  // before choosing managed PostgreSQL. Boot still must not manufacture or
  // overwrite its URL; Rust unit tests cover both database-selection branches.
  const productionBoot = rustBoot.split("#[cfg(test)]")[0];
  assert.match(productionBoot, /\.get\("DATABASE_URL"\)/);
  assert.doesNotMatch(
    productionBoot,
    /\.insert\s*\(\s*["']DATABASE_URL["']|set_env_flag\s*\([^;]*["']DATABASE_URL["']/
  );
  assert.doesNotMatch(productionBoot, /postgres(?:ql)?:\/\//);
});
