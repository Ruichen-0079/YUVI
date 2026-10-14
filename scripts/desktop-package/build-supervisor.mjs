import { javascriptNotices } from "./javascript-notices.mjs";
/**
 * Bundle desktop-supervisor + CLI into a single CommonJS file, then package
 * with @yao-pkg/pkg into a Windows x64 executable. A packaged build is never
 * allowed to silently fall back to Node+CJS or reuse a stale executable.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PKG_TARGET,
  REPO_ROOT,
  SUPERVISOR_BUNDLE_NAME,
  SUPERVISOR_EXE_NAME,
  SUPERVISOR_OUT_DIR
} from "./constants.mjs";
import { assertFile, ensureDir } from "./paths.mjs";

export const SUPERVISOR_BUILD_INFO_NAME = "supervisor-build-info.json";
export const SUPERVISOR_SOURCE_FILES = [
  "scripts/yuvi-desktop-supervisor.packaged.mjs",
  "packages/desktop-supervisor/src/supervisor.ts",
  "packages/desktop-supervisor/src/ownership.ts",
  "packages/desktop-supervisor/src/config.ts",
  "packages/desktop-supervisor/src/types.ts",
  "packages/desktop-supervisor/src/env.ts",
  "packages/config/src/environment.ts"
];
const BUNDLE_HASH_PLACEHOLDER = "0".repeat(64);

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function resolveCheckoutSha() {
  const fromEnvironment = process.env.GITHUB_SHA?.trim();
  if (fromEnvironment && /^[0-9a-f]{40}$/i.test(fromEnvironment))
    return fromEnvironment.toLowerCase();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .trim()
      .toLowerCase();
  } catch (error) {
    throw new Error(
      `unable to resolve checkout SHA: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function computeSupervisorSourceFingerprint() {
  const hash = crypto.createHash("sha256");
  for (const relativePath of SUPERVISOR_SOURCE_FILES) {
    const absolutePath = path.join(REPO_ROOT, ...relativePath.split("/"));
    assertFile(absolutePath, `Supervisor source ${relativePath}`);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(absolutePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function canonicalBundleText(text) {
  return String(text).replace(
    /("bundleSha256"\s*:\s*")[0-9a-f]{64}("\s*[,}])/gi,
    `$1${BUNDLE_HASH_PLACEHOLDER}$2`
  );
}

function canonicalBundleSha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(canonicalBundleText(fs.readFileSync(filePath, "utf8")))
    .digest("hex");
}

function embeddedBuildInfoBanner(identity) {
  return `globalThis.__YUVI_SUPERVISOR_BUILD_INFO__ = Object.freeze(${JSON.stringify(identity)});`;
}

async function bundleSupervisorWithIdentity(outfile, identity) {
  const result = await build({
    metafile: true,
    entryPoints: [path.join(REPO_ROOT, "scripts", "yuvi-desktop-supervisor.packaged.mjs")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    sourcemap: false,
    logLevel: "info",
    banner: {
      js: `/* YUVI packaged Supervisor — do not edit */\n${embeddedBuildInfoBanner(identity)}`
    }
  });
  fs.writeFileSync(
    path.join(path.dirname(outfile), "THIRD_PARTY_NOTICES.supervisor.json"),
    JSON.stringify(javascriptNotices(Object.keys(result.metafile.inputs)), null, 2)
  );
  assertFile(outfile, "supervisor cjs bundle");
}

export async function bundleSupervisorCjs(outDir = SUPERVISOR_OUT_DIR) {
  ensureDir(outDir);
  const entry = path.join(REPO_ROOT, "scripts", "yuvi-desktop-supervisor.packaged.mjs");
  assertFile(entry, "packaged supervisor entry");
  const outfile = path.join(outDir, SUPERVISOR_BUNDLE_NAME);
  const identity = {
    schemaVersion: 1,
    mode: "pkg-exe",
    checkoutSha: resolveCheckoutSha(),
    sourceFingerprint: computeSupervisorSourceFingerprint(),
    bundleSha256: BUNDLE_HASH_PLACEHOLDER,
    entry: "yuvi-desktop-supervisor.packaged.cjs"
  };
  fs.rmSync(outfile, { force: true });
  await bundleSupervisorWithIdentity(outfile, identity);
  identity.bundleSha256 = canonicalBundleSha256(outfile);
  fs.rmSync(outfile, { force: true });
  await bundleSupervisorWithIdentity(outfile, identity);
  if (canonicalBundleSha256(outfile) !== identity.bundleSha256) {
    throw new Error("Supervisor bundle canonical SHA changed after embedding build identity");
  }
  assertFile(outfile, "supervisor cjs bundle");
  return outfile;
}

export function packageSupervisorExe(cjsPath, outDir = SUPERVISOR_OUT_DIR) {
  ensureDir(outDir);
  const exePath = path.join(outDir, SUPERVISOR_EXE_NAME);
  fs.rmSync(exePath, { force: true });
  const pkgBin = path.join(REPO_ROOT, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js");
  const pkgCli = path.join(REPO_ROOT, "node_modules", ".bin", "pkg");
  const pkgCmd =
    process.platform === "win32" ? path.join(REPO_ROOT, "node_modules", ".bin", "pkg.cmd") : pkgCli;

  const args = [cjsPath, "--target", PKG_TARGET, "--output", exePath, "--compress", "GZip"];

  try {
    if (fs.existsSync(pkgCmd)) {
      execFileSync(pkgCmd, args, {
        stdio: "inherit",
        cwd: REPO_ROOT,
        shell: process.platform === "win32"
      });
    } else if (fs.existsSync(pkgBin)) {
      execFileSync(process.execPath, [pkgBin, ...args], { stdio: "inherit", cwd: REPO_ROOT });
    } else {
      throw new Error("@yao-pkg/pkg is not installed (run pnpm install)");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`pkg failed while packaging Supervisor: ${message}`);
  }

  if (!fs.existsSync(exePath)) {
    throw new Error("pkg produced no Supervisor exe");
  }
  return { exePath, cjsPath, mode: "pkg-exe" };
}

export async function buildSupervisor(outDir = SUPERVISOR_OUT_DIR) {
  const cjsPath = await bundleSupervisorCjs(outDir);
  const packaged = packageSupervisorExe(cjsPath, outDir);
  const bundleInfo = JSON.parse(
    fs
      .readFileSync(cjsPath, "utf8")
      .match(/__YUVI_SUPERVISOR_BUILD_INFO__ = Object\.freeze\((\{.*?\})\);/)?.[1] ?? "null"
  );
  if (!bundleInfo) throw new Error("embedded Supervisor build identity missing from CJS bundle");
  const buildInfo = {
    schemaVersion: 1,
    mode: packaged.mode,
    checkoutSha: bundleInfo.checkoutSha,
    sourceFingerprint: bundleInfo.sourceFingerprint,
    bundleSha256: bundleInfo.bundleSha256,
    bundleInputSha256: sha256File(cjsPath),
    entry: bundleInfo.entry,
    bundleRelativePath: `supervisor/${SUPERVISOR_BUNDLE_NAME}`,
    executableRelativePath: `supervisor/${SUPERVISOR_EXE_NAME}`,
    executableSha256: sha256File(packaged.exePath),
    pkgTarget: PKG_TARGET,
    platform: "win32",
    arch: "x64"
  };
  fs.writeFileSync(
    path.join(outDir, SUPERVISOR_BUILD_INFO_NAME),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
    "utf8"
  );
  return { ...packaged, buildInfo };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("build-supervisor.mjs");
if (isMain) {
  buildSupervisor()
    .then((result) => {
      console.info(`[desktop-package] supervisor mode: ${result.mode}`);
      console.info(`[desktop-package] cjs: ${result.cjsPath}`);
      if (result.exePath) console.info(`[desktop-package] exe: ${result.exePath}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
