import { createRequire, builtinModules } from "node:module";
import { resolve, dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const here = dirname(new URL(import.meta.url).pathname);
if (!process.argv[2]) throw new Error("Usage: node run.mjs MAIN_CHECKOUT");
const root = resolve(process.argv[2]);
const { build } = createRequire(join(root, "package.json"))("esbuild");
const outfile = join(here, ".generated-backend.mjs");
const bundled = await build({
  entryPoints: [join(here, "backend.ts")],
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
const result = spawnSync(process.execPath, [outfile], {
  encoding: "utf8",
  env: { ...process.env, AUDIT_REPO: root, NODE_ENV: "development", PROVIDER_ALLOW_MOCKS: "false" }
});
if (result.status !== 0) throw new Error(result.stderr + "\n" + result.stdout);
const line = result.stdout.split("\n").find((l) => l.startsWith("AUDIT_RESULT="));
if (!line) throw new Error(result.stdout);
const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const output = {
  sourceSHA: sha,
  node: process.version,
  kind: "deterministic-control-and-input-probes",
  actualModelCalls: 0,
  projectInputCount: Object.keys(bundled.metafile.inputs).filter((p) =>
    /(^|\/)(packages|apps)\//.test(p)
  ).length,
  probes: JSON.parse(line.slice(13))
};
writeFileSync(join(here, "backend-results.json"), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
