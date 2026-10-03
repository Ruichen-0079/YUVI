import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { LocalSTTProvider, type VoiceProfileProvider } from "@companion/providers";
import type { AppContext } from "../context.js";

export function hasPackagedVoice(): boolean {
  return Boolean(process.env["YUVI_PACKAGED"] && process.env["YUVI_SUPERVISOR_ENDPOINT_FILE"]);
}
async function control(route: string, body = {}): Promise<Record<string, unknown>> {
  const file = process.env["YUVI_SUPERVISOR_ENDPOINT_FILE"];
  if (!file || !isAbsolute(file)) throw new Error("Packaged Supervisor endpoint is unavailable.");
  const endpoint = JSON.parse(readFileSync(file, "utf8")) as { host: string; port: number; controlToken: string };
  if (endpoint.host !== "127.0.0.1" || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new Error("Invalid Supervisor endpoint.");
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, { method: "POST", headers: { "content-type": "application/json", "x-yuvi-control-token": endpoint.controlToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000), redirect: "error" });
  if (!response.ok) throw new Error("Packaged speaker recognition is unavailable.");
  return response.json() as Promise<Record<string, unknown>>;
}
/** The existing LocalSTTProvider handles the wire contract; Supervisor owns the bounded process lease. */
export function productVoiceProfiles(context: AppContext): VoiceProfileProvider | undefined {
  if (!hasPackagedVoice()) return context.providers.getSTTProvider().voiceProfiles;
  async function use<T>(fn: (profiles: VoiceProfileProvider) => Promise<T>): Promise<T> {
    const lease = await control("/v1/voice/acquire");
    try {
      const provider = new LocalSTTProvider({ baseUrl: String(lease["baseUrl"]), model: "sensevoice" });
      return await fn(provider.voiceProfiles);
    } finally { await control("/v1/voice/release", { leaseId: lease["leaseId"] }); }
  }
  return {
    list: () => use(p => p.list()),
    readAuthorityState: () => use(async p => {
      if (!p.readAuthorityState) throw new Error("Acoustic owner revision lookup is unavailable.");
      return p.readAuthorityState();
    }),
    enroll: input => use(p => p.enroll(input)),
    identify: input => use(p => p.identify(input)),
    delete: id => use(p => p.delete(id)),
    fenceNativeCommand: command => use(async p => {
      if (!p.fenceNativeCommand) throw new Error("Acoustic command fencing is unavailable.");
      return p.fenceNativeCommand(command);
    }),
    applyNativeCommand: command => use(async p => {
      if (!p.applyNativeCommand) throw new Error("Governed acoustic commands are unavailable.");
      return p.applyNativeCommand(command);
    }),
    reconcileNativeCommand: command => use(async p => {
      if (!p.reconcileNativeCommand) throw new Error("Acoustic command reconciliation is unavailable.");
      return p.reconcileNativeCommand(command);
    })
  };
}

export async function applyPackagedSpeechRoute(context: AppContext): Promise<void> {
  if (!hasPackagedVoice()) return;
  const raw = context.activeRuntimeEnv["YUVI_PRODUCT_CONFIGURATION"];
  const catalog = raw ? JSON.parse(raw) : null;
  const assigned = catalog?.routes.stt.some((id: string) => {
    const model = catalog.models.find((m: { id: string }) => m.id === id);
    const provider = catalog.providers.find((p: { id: string }) => p.id === model?.providerId);
    return model?.enabled && provider?.adapter === "local-stt" && provider.baseUrl.replace(/\/$/, "") === (process.env["LOCAL_STT_BASE_URL"] ?? "http://127.0.0.1:9876");
  });
  await control("/v1/config", { env: { YUVI_AUTOSTART_LOCAL_STT: assigned ? "1" : "0" } });
}
