import { build } from "esbuild";
import { cp, mkdir, rm, chmod, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { javascriptNotices } from "../desktop-package/javascript-notices.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.argv[2] ?? join(repo, "artifacts", "plunge-webui"));
const stage = join(output, "Plunge-WebUI-linux-x64");
await mkdir(output, { recursive: true });
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, "runtime"), { recursive: true });
const result = await build({
  entryPoints: [join(repo, "apps/server/src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(stage, "runtime/plunge.mjs"),
  packages: "bundle",
  external: ["pg-native", "bufferutil", "utf-8-validate"],
  metafile: true,
  banner: {
    js: 'import { createRequire as __plungeRequire } from "node:module"; import { fileURLToPath as __plungeFileURL } from "node:url"; import { dirname as __plungeDirname } from "node:path"; const require=__plungeRequire(import.meta.url); const __filename=__plungeFileURL(import.meta.url); const __dirname=__plungeDirname(__filename);'
  }
});
for (const item of Object.values(result.metafile.outputs))
  for (const imp of item.imports)
    if (
      imp.external &&
      !imp.path.startsWith("node:") &&
      !builtinModules.includes(imp.path) &&
      !["pg-native", "bufferutil", "utf-8-validate"].includes(imp.path)
    )
      throw Error("Unexpected external " + imp.path);
// Reuse the existing standalone Node distribution; no system Node, pnpm or network install at deployment.
const nodePath = process.env.PLUNGE_NODE_PATH ?? process.execPath;
const nodeInfo = JSON.parse(
  execFileSync(
    nodePath,
    [
      "-p",
      "JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node})"
    ],
    { encoding: "utf8" }
  )
);
if (
  nodeInfo.platform !== "linux" ||
  nodeInfo.arch !== "x64" ||
  Number(nodeInfo.version.split(".")[0]) < 22
)
  throw Error("Provide Linux x64 Node >=22 through PLUNGE_NODE_PATH.");
execFileSync(nodePath, ["--check", join(stage, "runtime/plunge.mjs")]);
await cp(nodePath, join(stage, "runtime/node"));
await chmod(join(stage, "runtime/node"), 0o755);
const nodeLicense = process.env.PLUNGE_NODE_LICENSE_PATH;
if (nodeLicense) await cp(nodeLicense, join(stage, "runtime/NODE-LICENSE.txt"));
else throw Error("Provide the bundled Node distribution LICENSE through PLUNGE_NODE_LICENSE_PATH.");
await cp(join(repo, "apps/server/plunge-webui"), join(stage, "webui"), { recursive: true });
await cp(join(repo, "scripts/plunge/launch.mjs"), join(stage, "launch.mjs"));
await writeFile(
  join(stage, "start.sh"),
  '#!/bin/sh\nset -eu\nPLUNGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$PLUNGE_ROOT/runtime/node" "$PLUNGE_ROOT/launch.mjs" "$@"\n'
);
await chmod(join(stage, "start.sh"), 0o755);
await cp(join(repo, "scripts/plunge/start-webui.sh"), join(stage, "start-webui.sh"));
await chmod(join(stage, "start-webui.sh"), 0o755);
await cp(join(repo, "docs/plunge-webui.md"), join(stage, "README.md"));
await writeFile(
  join(stage, "THIRD-PARTY-NOTICES.txt"),
  JSON.stringify(javascriptNotices(Object.keys(result.metafile.inputs)), null, 2)
);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
await writeFile(
  join(stage, "build.json"),
  JSON.stringify(
    {
      version: 1,
      commit,
      platform: "linux-x64",
      node: execFileSync(nodePath, ["--version"], { encoding: "utf8" }).trim(),
      builtAt: new Date().toISOString()
    },
    null,
    2
  )
);
const zip = join(output, "Plunge-WebUI-linux-x64.zip");
await rm(zip, { force: true });
execFileSync("python3", [
  "-c",
  `import zipfile,pathlib,sys
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:
 for p in root.rglob('*'):
  if p.is_file(): z.write(p,p.relative_to(root.parent))
`,
  stage,
  zip
]);
console.log(zip);
