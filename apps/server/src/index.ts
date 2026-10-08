import { readCharacterComposition, preserveCharacterEnvironment } from "./character-composition.js";
import { loadServerConfig } from "./config.js";
import { applyRuntimeEnv, getLegacyServerLocalEnvWarning, readRuntimeEnvFiles } from "./env.js";
import { buildServer } from "./server.js";
import { composePlunge } from "./plunge/qq-composition.js";
import { PlungeDesktopApps } from "./plunge/desktop-apps.js";
import { dirname, join } from "node:path";

const composition = readCharacterComposition(
  process.env["YUVI_CHARACTER_CONFIG_PATH"],
  process.env
);
const bootFiles = composition
  ? await readRuntimeEnvFiles({ env: composition.env })
  : await readRuntimeEnvFiles();
const actorEnv = composition
  ? preserveCharacterEnvironment(composition, bootFiles.env)
  : bootFiles.env;
if (!composition) applyRuntimeEnv(actorEnv);
console.info("[env] runtimeEnvDir:", bootFiles.runtimeEnvDir);
console.info("[env] .env exists:", bootFiles.base.exists);
console.info("[env] .env.local exists:", bootFiles.local.exists);
console.info("[env] DEEPSEEK_API_KEY configured:", Boolean(actorEnv["DEEPSEEK_API_KEY"]));
console.info("[env] DEEPSEEK_CHAT_MODEL:", actorEnv["DEEPSEEK_CHAT_MODEL"] ?? "");
console.info("[env] MEMORY_REPOSITORY:", actorEnv["MEMORY_REPOSITORY"] ?? "in-memory");
console.info("[env] DATABASE_URL configured:", Boolean(actorEnv["DATABASE_URL"]));

const legacyWarning = composition ? null : await getLegacyServerLocalEnvWarning();
if (legacyWarning) console.warn("[env]", legacyWarning);

// ZIP startup owns the management listener/token; private env files cannot widen its bind.
if (process.env["YUVI_PLUNGE_WEBUI_DIR"] && composition) {
  actorEnv["YUVI_PLUNGE_WEBUI_DIR"] = process.env["YUVI_PLUNGE_WEBUI_DIR"];
  actorEnv["DASHBOARD_DEV_TOKEN"] = process.env["DASHBOARD_DEV_TOKEN"];
  actorEnv["SERVER_HOST"] = "127.0.0.1";
  actorEnv["SERVER_PORT"] = process.env["YUVI_PLUNGE_WEBUI_PORT"] ?? "6135";
}
const config = loadServerConfig(actorEnv);
const plungeFile = actorEnv["YUVI_PLUNGE_CONFIG_PATH"];
if (plungeFile && !composition) throw Error("Plunge requires an independent Alice composition.");
const surfacePlugins =
  plungeFile && composition
    ? composePlunge(plungeFile, composition, (event) =>
        console.info("[plunge]", JSON.stringify(event))
      )
    : undefined;
const app = await buildServer(config, {
  ...(composition ? { characterComposition: composition } : {}),
  ...(surfacePlugins ? { surfacePlugins } : {}),
  ...(surfacePlugins && actorEnv["YUVI_PLUNGE_WEBUI_DIR"]
    ? {
        plungeWebUI: {
          directory: actorEnv["YUVI_PLUNGE_WEBUI_DIR"]!,
          management: surfacePlugins.management,
          desktop: new PlungeDesktopApps({
            qqPath: process.env["YUVI_PLUNGE_QQ_PATH"],
            snowlumaDirectory: process.env["YUVI_PLUNGE_SNOWLUMA_DIR"],
            stateDirectory: join(dirname(actorEnv["YUVI_PLUNGE_WEBUI_DIR"]!), "state"),
            isConnected: () => surfacePlugins.management.snapshot().connection?.ready ?? false
          }),
          token: actorEnv["DASHBOARD_DEV_TOKEN"] ?? ""
        }
      }
    : {})
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down server");
  await app.close();
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await app.listen({ host: config.host, port: config.port });
