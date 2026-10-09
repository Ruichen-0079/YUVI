import { createRequire, builtinModules } from "node:module";
import { resolve, dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const here = dirname(new URL(import.meta.url).pathname);
if (!process.argv[2] || !process.argv[3])
  throw new Error("Usage: node run.mjs MAIN_CHECKOUT PLUNGE_CHECKOUT");
const installed = resolve(process.argv[2]);
const branch = resolve(process.argv[3]);
const { build } = createRequire(join(installed, "package.json"))("esbuild");
for (const [label, root] of [
  ["main", installed],
  ["plunge", branch]
]) {
  const outfile = join(here, `.generated-${label}.mjs`);
  const result = await build({
    entryPoints: [join(here, `${label}.ts`)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    metafile: true,
    logLevel: "silent",
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
    },
    plugins: [
      {
        name: "pinned-source",
        setup(b) {
          b.onResolve({ filter: /^#repo\// }, (a) => ({ path: join(root, a.path.slice(6)) }));
          b.onResolve({ filter: /^@companion\// }, (a) => {
            const [pkg, ...rest] = a.path.slice(11).split("/");
            const folder = join(root, "packages", pkg);
            const json = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
            const ex = json.exports[rest.length ? "./" + rest.join("/") : "."];
            const file = typeof ex === "string" ? ex : ex.development || ex.import;
            if (!file) throw new Error(`Cannot resolve ${a.path}`);
            return { path: resolve(folder, file) };
          });
          b.onResolve({ filter: /^[^./]/ }, (a) => {
            if (a.path.startsWith("node:") || builtinModules.includes(a.path))
              return { path: a.path, external: true };
            if (a.path === "pg-native") return { path: a.path, external: true };
            const importer = a.importer.startsWith(root)
              ? installed + a.importer.slice(root.length)
              : a.importer.startsWith(installed)
                ? a.importer
                : join(installed, "package.json");
            return { path: createRequire(importer).resolve(a.path) };
          });
        }
      }
    ]
  });
  const projectInputs = Object.keys(result.metafile.inputs).filter(
    (p) => p.includes("/packages/") || p.includes("/apps/")
  );
  if (label === "plunge" && projectInputs.some((p) => resolve(p).startsWith(installed + "/")))
    throw new Error("Mixed main and branch source");
  const run = spawnSync(process.execPath, [outfile], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "development", PROVIDER_ALLOW_MOCKS: "false" }
  });
  if (run.status !== 0) throw new Error(run.stderr + "\n" + run.stdout);
  const resultLine = run.stdout.split("\n").find((s) => s.startsWith("AUDIT_RESULT="));
  if (!resultLine) throw new Error("No probe result: " + run.stdout);
  writeFileSync(
    join(here, `${label}-results.json`),
    JSON.stringify(JSON.parse(resultLine.slice(13)), null, 2) + "\n"
  );
  console.log(label + ": " + resultLine.slice(13));
}
