import { readCharacterComposition, preserveCharacterEnvironment } from "./character-composition.js";
import { loadServerConfig } from "./config.js";
import { applyRuntimeEnv, getLegacyServerLocalEnvWarning, readRuntimeEnvFiles } from "./env.js";
import { buildServer } from "./server.js";

const runtimeEnvFiles = await readRuntimeEnvFiles();
const composition = readCharacterComposition(
  process.env["YUVI_CHARACTER_CONFIG_PATH"],
  runtimeEnvFiles.env
);
const bootFiles = composition
  ? await readRuntimeEnvFiles({ env: composition.env })
  : runtimeEnvFiles;
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

const config = loadServerConfig(actorEnv);
const app = await buildServer(config, composition ? { characterComposition: composition } : {});

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
