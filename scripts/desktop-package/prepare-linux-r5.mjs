/** R5 text desktop distribution. Uses the existing Linux release builders and launcher.
 * Mem0, STT/TTS models and licensed Cubism Core are explicitly outside this profile. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { REPO_ROOT, MEMORY_MIGRATIONS_DIR } from "./constants.mjs";
import { releaseSource, releaseVersion } from "./release-identity.mjs";
import { prepareLinuxNode, NODE_VERSION } from "./prepare-linux-daily.mjs";
import { buildLinuxWeb } from "./build-linux-web.mjs";
import { bundleSupervisorCjs } from "./build-supervisor.mjs";
import { bundleRuntimeServer } from "./build-runtime.mjs";
import { stageLinuxPostgresDistribution } from "./stage-linux-postgres.mjs";

const checkoutSha = releaseSource(), version = releaseVersion();
const out = path.join(REPO_ROOT, "build/desktop/linux-r5-x64");
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const desktop = process.env.YUVI_LINUX_DESKTOP_BINARY || path.join(REPO_ROOT, "build/desktop/debian-target/release/yuvi-desktop");
const proof = JSON.parse(fs.readFileSync(desktop + ".provenance.json", "utf8"));
if (proof.checkoutSha !== checkoutSha || proof.version !== version || proof.sha256 !== sha(desktop) || proof.baseline !== "Debian 12 / glibc 2.36") {
  throw Error("R5 desktop source/binary provenance mismatch");
}
fs.rmSync(out, { recursive: true, force: true });
for (const part of ["runtime", "supervisor", "desktop", "web"]) fs.mkdirSync(path.join(out, part), { recursive: true });
await prepareLinuxNode(path.join(out, "runtime"));
await bundleSupervisorCjs(path.join(out, "supervisor"));
const runtime = await bundleRuntimeServer(path.join(out, "runtime"));
fs.rmSync(runtime.metafilePath);
const manifest = JSON.parse(fs.readFileSync(runtime.manifestPath, "utf8"));
Object.assign(manifest, { platform: "linux", arch: "x64", nodeExecutable: "node", nodeVersion: NODE_VERSION });
fs.writeFileSync(runtime.manifestPath, JSON.stringify(manifest, null, 2));
fs.cpSync(MEMORY_MIGRATIONS_DIR, path.join(out, "runtime/migrations"), { recursive: true });
stageLinuxPostgresDistribution({ destination: path.join(out, "postgres") });
await buildLinuxWeb();
fs.cpSync(path.join(REPO_ROOT, "apps/web/dist"), path.join(out, "web/dist"), { recursive: true });
for (const [source, target] of [
  [desktop, "desktop/yuvi-desktop"], [desktop + ".provenance.json", "desktop/build-provenance.json"],
  [path.join(REPO_ROOT, "apps/desktop/src-tauri/icons/128x128@2x.png"), "desktop/yuvi.png"],
  ...[ ["yuvi-linux", "yuvi"], ["linux-launcher.mjs", "launcher.mjs"], ["linux-lifecycle.mjs", "linux-lifecycle.mjs"], ["portable-state.mjs", "portable-state.mjs"],
    ["provision-cubism-core.mjs", "provision-cubism-core.mjs"], ["linux-static-web-server.mjs", "web/static-server.mjs"],
    ["install-linux-r5-dependencies.sh", "install-system-dependencies.sh"]
  ].map(([s,t]) => [path.join(REPO_ROOT, "scripts/desktop-package", s), t])
]) fs.copyFileSync(source, path.join(out, target));
for (const file of ["yuvi", "desktop/yuvi-desktop", "install-system-dependencies.sh"]) fs.chmodSync(path.join(out, file), 0o755);
fs.writeFileSync(path.join(out, "install-manifest.json"), JSON.stringify({
  schemaVersion: 1, kind: "yuvi-linux-daily-packaged", platform: "linux-x64", profile: "r5", checkoutSha, version, nodeVersion: NODE_VERSION,
  baseline: "Debian 12 / glibc 2.36", installation: "extract immutable archive + install declared system packages; run ./yuvi",
  components: ["bundled-node", "supervisor", "runtime", "migrations-001-045", "postgresql-16-pgvector", "native-desktop", "web", "offline-fonts"],
  excluded: ["Mem0", "STT/TTS sidecars and models", "licensed Cubism Core", "provider credentials", "user identity and data"],
  network: "System dependency installation requires apt network or a separately supplied offline OS repository. Application archive is self-contained after OS dependencies. Language providers require their configured network service.",
  secretStorage: "Unlocked user Secret Service; no plaintext production fallback"
}, null, 2));
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) files.push({ path: path.relative(out, full), size: fs.statSync(full).size, sha256: sha(full) });
    else throw Error("Unsupported release resource: " + full);
  }
}
walk(out);
fs.writeFileSync(path.join(out, "checksums.json"), JSON.stringify({ schema: "yuvi.release-files.v1", checkoutSha, files }, null, 2));
if (releaseSource() !== checkoutSha) throw Error("Release source changed during packaging");
const archive = path.join(path.dirname(out), `YUVI-R5-${version}-${checkoutSha.slice(0,12)}-linux-x64.tar.gz`);
execFileSync("tar", ["-czf", archive, "-C", out, "."], { stdio: "inherit" });
console.log(JSON.stringify({ archive, sha256: sha(archive), files: files.length }));
