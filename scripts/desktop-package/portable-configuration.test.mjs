import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  portableSecretNamespace,
  readPortablePackageIdentity
} from "./portable-state.mjs";

const launcher = fs.readFileSync(new URL("./linux-launcher.mjs", import.meta.url), "utf8");

test("Portable launcher keeps instance identity isolated while restoring durable Product config", () => {
  assert.match(launcher, /runtimePort = 16121/);
  assert.match(launcher, /YUVI_DESKTOP_SUPERVISOR_BINDING: 'attach'/);
  assert.match(launcher, /YUVI_RUNTIME_ENV_DIR: dirs\.config/);
  assert.match(launcher, /XDG_CONFIG_HOME: dirs\.config/);
  assert.match(launcher, /XDG_DATA_HOME: dirs\.data/);
  assert.match(launcher, /XDG_CACHE_HOME: dirs\.cache/);
  assert.match(launcher, /YUVI_SECRET_NAMESPACE: secretNamespace/);
  assert.match(launcher, /portableSecretNamespace\(packageIdentity\)/);

  // Parent process credentials or Installed state must never be imported wholesale.
  assert.doesNotMatch(launcher, /\.\.\.process\.env/);
  for (const secret of [
    "DEEPSEEK_API_KEY",
    "OPENAI_COMPATIBLE_API_KEY",
    "XAI_API_KEY",
    "DASHSCOPE_API_KEY",
    "NVIDIA_API_KEY",
    "DATABASE_URL"
  ]) {
    assert.equal(launcher.includes(secret), false, `${secret} must not cross the Portable boundary`);
  }

  // Product-owned routing/defaults are restored from the versioned config root instead of
  // being reset by the launcher on every restart.
  const fullProfile = launcher.replace(/\.\.\.\(r5Only \? \{[^\n]+\} : \{\}\),/g, "");
  assert.match(launcher, /r5Only \? \{ YUVI_PACKAGE_PROFILE: 'r5'/);
  assert.doesNotMatch(fullProfile, /MEMORY_BACKEND:\s*'legacy'/);
  assert.doesNotMatch(fullProfile, /YUVI_AUTOSTART_LOCAL_STT:\s*'0'/);
  assert.doesNotMatch(fullProfile, /YUVI_AUTOSTART_TTS:\s*'0'/);

  // A9 packages and owns private PostgreSQL + Mem0. Portable must no longer disable them.
  assert.doesNotMatch(fullProfile, /YUVI_PACKAGED_EXTERNAL_SIDECARS:\s*'1'/);
  assert.doesNotMatch(launcher, /YUVI_POSTGRES_MODE:\s*'external'/);
  assert.doesNotMatch(fullProfile, /YUVI_AUTOSTART_MEM0:\s*'0'/);
});

test("Portable starts presentation after its control plane without a Runtime lifecycle deadline", () => {
  const controlReady = launcher.indexOf("const controlDeadline");
  const desktopStart = launcher.indexOf("desktop = spawn(desktopShell");
  const webStart = launcher.indexOf("web = spawn");
  assert.ok(controlReady >= 0);
  assert.ok(desktopStart > controlReady);
  assert.ok(webStart > desktopStart);
  assert.doesNotMatch(launcher, /runtimeDeadline|runtime\?\.status|runtime\?\.ownership/);
  assert.match(launcher, /active.pid !== expectedSupervisorPid/);
});

test("Portable secret namespace follows the validated release version", () => {
  assert.equal(portableSecretNamespace({ version: "0.1.2" }), "YUVI-portable-0.1.2");
  assert.equal(portableSecretNamespace({ version: "0.1.3" }), "YUVI-portable-0.1.3");
  assert.notEqual(
    portableSecretNamespace({ version: "0.1.1" }),
    portableSecretNamespace({ version: "0.1.2" })
  );
  assert.throws(() => portableSecretNamespace({ version: "../0.1.2" }), /identity is invalid/);
  assert.throws(() => portableSecretNamespace({ version: "0.1" }), /identity is invalid/);
});

test("manifest validation remains the namespace authority", () => {
  const source = readPortablePackageIdentity.toString();
  assert.match(source, /install-manifest\.json/);
  assert.match(source, /Portable package identity is invalid/);
  assert.doesNotMatch(launcher, /packageIdentity\.checkoutSha.*SECRET_NAMESPACE/);
});
