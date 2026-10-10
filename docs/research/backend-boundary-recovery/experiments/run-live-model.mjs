import { createRequire, builtinModules } from "node:module";
import { resolve, dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const here = dirname(new URL(import.meta.url).pathname);
if (!process.argv[2])
  throw new Error("Usage: node run-live-model.mjs CHECKOUT [--plan|--run] [OUTPUT_DIR]");
const root = resolve(process.argv[2]);
const { build } = createRequire(join(root, "package.json"))("esbuild");
const outfile = join(here, ".generated-live-model.mjs");
const bundled = await build({
  entryPoints: [join(here, "live-model.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  metafile: true,
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  },
  plugins: [
    {
      name: "single-checkout-source",
      setup(b) {
        b.onResolve({ filter: /^#repo\// }, (a) => ({ path: join(root, a.path.slice(6)) }));
        b.onResolve({ filter: /^@companion\// }, (a) => {
          const [pkg, ...rest] = a.path.slice(11).split("/");
          const folder = join(root, "packages", pkg);
          const json = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
          const ex = json.exports[rest.length ? "./" + rest.join("/") : "."];
          return {
            path: resolve(folder, typeof ex === "string" ? ex : ex.development || ex.import)
          };
        });
        b.onResolve({ filter: /^[^./]/ }, (a) => {
          if (
            a.path.startsWith("node:") ||
            builtinModules.includes(a.path) ||
            a.path === "pg-native"
          )
            return { path: a.path, external: true };
          return {
            path: createRequire(
              a.importer.startsWith(root) ? a.importer : join(root, "package.json")
            ).resolve(a.path)
          };
        });
      }
    }
  ]
});
const outputDir = resolve(process.argv[4] ?? join(here, "model-output"));
const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const result = spawnSync(process.execPath, [outfile, process.argv[3] ?? "--plan"], {
  stdio: "inherit",
  env: { ...process.env, YUVI_AUDIT_SOURCE_SHA: sha, YUVI_AUDIT_OUTPUT: outputDir }
});
if (result.status !== 0) process.exitCode = result.status ?? 1;
