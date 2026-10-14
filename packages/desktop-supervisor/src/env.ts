import fs from "node:fs";
import { parseBooleanSetting } from "@companion/config/environment";
import path from "node:path";

/**
 * Load root .env then .env.local (local overrides).
 * Does not log values. Shell env wins over .env but loses to .env.local for
 * development parity with scripts/dev.ps1 (shell preserved over base .env).
 */
export function loadYuviEnvFiles(repositoryRoot: string): Record<string, string> {
  const configured = process.env["YUVI_RUNTIME_ENV_DIR"]?.trim();
  const envRoot = configured ? path.resolve(repositoryRoot, configured) : repositoryRoot;
  const result: Record<string, string> = {};
  const base = readEnvFile(path.join(envRoot, ".env"));
  Object.assign(result, base);
  // Preserve process env over base .env
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") result[key] = value;
  }
  const local = readEnvFile(path.join(envRoot, ".env.local"));
  Object.assign(result, local);
  return result;
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.indexOf("=");
    if (sep <= 0) continue;
    const name = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

/**
 * Load user runtime env from an absolute config directory (Linux daily / packaged).
 * Never pass the install resource root here — only YUVI_RUNTIME_ENV_DIR.
 * Precedence: .env < process.env < .env.local (same as development).
 */
export function loadYuviRuntimeEnvDir(envDir: string): Record<string, string> {
  if (!path.isAbsolute(envDir)) {
    throw new Error("YUVI_RUNTIME_ENV_DIR must be an absolute path");
  }
  const result: Record<string, string> = {};
  Object.assign(result, readEnvFile(path.join(envDir, ".env")));
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") result[key] = value;
  }
  Object.assign(result, readEnvFile(path.join(envDir, ".env.local")));
  return result;
}

export function envFlag(env: Record<string, string>, key: string, defaultValue: boolean): boolean {
  return parseBooleanSetting(env[key], defaultValue);
}

export function envString(env: Record<string, string>, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim();
}
