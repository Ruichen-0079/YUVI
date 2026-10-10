import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
// Adapter from the existing R3 private fetch recorder; do not load into Alice.
if (process.env.SERVER_PORT !== "31504" || !process.env.YUVI_EXPERIMENT_TRACE)
  throw new Error(
    "R4 recorder requires the explicitly isolated Server port and private trace directory"
  );
const root = process.env.YUVI_EXPERIMENT_TRACE;
await mkdir(root, { recursive: true, mode: 0o700 });
const original = globalThis.fetch;
let ordinal = 0;
let modelCalls = 0;
const parent = new URL("../", "file://" + root + "/").pathname;
for (const dir of await readdir(parent)) {
  if (!dir.endsWith("-calls")) continue;
  for (const file of await readdir(join(parent, dir))) {
    if (!file.startsWith("call-")) continue;
    try {
      const saved = JSON.parse(await readFile(join(parent, dir, file), "utf8"));
      if (saved.url.endsWith("/chat/completions")) modelCalls++;
    } catch {}
  }
}
globalThis.fetch = async (url, init) => {
  const id = ordinal++;
  let body;
  try {
    body = init?.body ? JSON.parse(String(init.body)) : null;
  } catch {
    body = "[non-JSON body]";
  }
  const originalBody = body;
  if (String(url).endsWith("/chat/completions") && body) {
    if (++modelCalls > 120) throw new Error("R4 model call budget exhausted");
    body = { ...body, temperature: 0, max_tokens: 2048 };
    init = { ...init, body: JSON.stringify(body) };
  }
  const start = performance.now();
  const record = { url: String(url), originalInput: originalBody, effectiveInput: body };
  try {
    let fault;
    try {
      fault = JSON.parse(await readFile(join(parent, "fault.json"), "utf8"));
    } catch {}
    const inject =
      fault && String(url).includes("/v1/memories/idempotent") && body?.scope === fault.scope;
    const response = inject
      ? new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: "VALIDATION_ERROR",
              message: "Synthetic isolated backend write rejection",
              retryable: false
            }
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        )
      : await original(url, init);
    if (inject) record.injectedFault = "isolated-backend-write-rejection";
    record.httpStatus = response.status;
    (async () => {
      const reader = response.clone().body.getReader();
      let output = "";
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        record.firstByteMs ??= performance.now() - start;
        output += decoder.decode(chunk.value, { stream: true });
        if (/"delta"\s*:\s*\{[^}]*"content"\s*:\s*"[^"}]+/.test(output))
          record.firstTextMs ??= performance.now() - start;
      }
      record.output = output + decoder.decode();
      record.latencyMs = performance.now() - start;
      await writeFile(join(root, `call-${id}.json`), JSON.stringify(record, null, 2), {
        mode: 0o600
      });
    })().catch(() => {});
    return response;
  } catch (error) {
    record.error = {
      name: error.name,
      code: error.code,
      causeCode: error.cause?.code,
      causeCodes: error.cause?.errors?.map((x) => x.code)
    };
    record.latencyMs = performance.now() - start;
    await writeFile(join(root, `call-${id}.json`), JSON.stringify(record), { mode: 0o600 });
    throw error;
  }
};
