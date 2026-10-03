/** Real packaged Linux Local STT smoke: health, SenseVoice, enroll, match, restart. */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { LINUX_BUILD_ROOT } from "./prepare-linux-daily.mjs";
import { validateLocalSttArtifact } from "./build-local-stt.mjs";
import { REPO_ROOT } from "./constants.mjs";

function request(url, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method,
        headers: body
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error("request timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function waitHealth(base, child) {
  const deadline = Date.now() + 90_000;
  let last = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local STT exited before health: ${last}`);
    try {
      const res = await request(`${base}/health`);
      if (res.status === 200 && res.json?.ok === true && res.json?.service === "yuvi-local-stt") {
        return res.json;
      }
      last = res.text;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Local STT health timed out: ${last}`);
}

export async function runLinuxLocalSttSmoke(options = {}) {
  const packageRoot = path.resolve(options.packageRoot ?? LINUX_BUILD_ROOT);
  const artifact = validateLocalSttArtifact(path.join(packageRoot, "local-stt"), {
    repoRoot: REPO_ROOT
  });
  const wav =
    options.wav ??
    path.join(
      REPO_ROOT,
      "build",
      "desktop",
      "local-stt-models",
      "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
      "test_wavs",
      "zh.wav"
    );
  const fallbackWav = path.join(
    os.homedir(),
    ".local",
    "share",
    "yuvi",
    "models",
    "stt",
    "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    "test_wavs",
    "zh.wav"
  );
  const fixture = fs.existsSync(wav) ? wav : fallbackWav;
  if (!fs.existsSync(fixture)) {
    throw new Error("SenseVoice zh.wav fixture is missing for packaged STT smoke.");
  }
  const audioBase64 = fs.readFileSync(fixture).toString("base64");
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-packaged-stt-"));
  const speakerDir = path.join(dataRoot, "speakers");
  fs.mkdirSync(speakerDir, { recursive: true });
  const port = options.port ?? 19876;
  const base = `http://127.0.0.1:${port}`;
  const start = () =>
    spawn(
      artifact.executable,
      [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--model-dir",
        artifact.modelRoot,
        "--yuvi-local-stt"
      ],
      {
        cwd: path.dirname(artifact.executable),
        env: {
          PATH: "/usr/bin:/bin",
          HOME: dataRoot,
          YUVI_LOCAL_STT_PACKAGED: "1",
          YUVI_STT_SPEAKER_DIR: speakerDir,
          CUDA_VISIBLE_DEVICES: ""
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

  const first = start();
  try {
    const health = await waitHealth(base, first);
    if (health.gpu !== false) throw new Error("packaged Local STT reported GPU");
    if (health.vad !== true) throw new Error("packaged Local STT VAD is not ready");
    const transcribed = await request(`${base}/transcribe`, {
      method: "POST",
      body: JSON.stringify({ audioBase64, mimeType: "audio/wav" })
    });
    if (transcribed.status !== 200 || !String(transcribed.json?.text || "").trim())
      throw new Error(`SenseVoice transcription failed: ${transcribed.text}`);
    const enrolled = await request(`${base}/speakers`, {
      method: "POST",
      body: JSON.stringify({
        audioBase64,
        mimeType: "audio/wav",
        voiceProfileId: "packaged-vp",
        label: "packaged"
      })
    });
    if (enrolled.status !== 200) throw new Error(`enrollment failed: ${enrolled.text}`);
    const matched = await request(`${base}/identify`, {
      method: "POST",
      body: JSON.stringify({ audioBase64, mimeType: "audio/wav" })
    });
    if (matched.json?.voiceProfileMatch?.status !== "MATCHED")
      throw new Error(`expected MATCHED, got ${matched.text}`);
    if (matched.json.voiceProfileMatch.voiceProfileId !== "packaged-vp")
      throw new Error("VoiceProfile id did not survive identify");
    first.kill("SIGTERM");
    await new Promise((resolve) => first.once("exit", resolve));
    const second = start();
    try {
      await waitHealth(base, second);
      const reloaded = await request(`${base}/identify`, {
        method: "POST",
        body: JSON.stringify({ audioBase64, mimeType: "audio/wav" })
      });
      if (reloaded.json?.voiceProfileMatch?.voiceProfileId !== "packaged-vp")
        throw new Error(`VoiceProfile did not survive sidecar restart: ${reloaded.text}`);
      const unknown = await request(`${base}/identify`, {
        method: "POST",
        body: JSON.stringify({
          audioBase64: fs.readFileSync(fixture).subarray(0, 44).toString("base64"),
          mimeType: "audio/wav"
        })
      });
      if (unknown.status === 200 && unknown.json?.voiceProfileMatch?.status === "MATCHED")
        throw new Error("too-short/unknown audio must not match a Person or VoiceProfile");
    } finally {
      second.kill("SIGTERM");
      await new Promise((resolve) => second.once("exit", resolve));
    }
    const manifestPath = path.join(speakerDir, "speaker-manifest.json");
    if (!fs.existsSync(manifestPath)) throw new Error("speaker generation manifest was not written under the data root");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const generation = path.join(speakerDir, manifest.generation);
    if (!fs.existsSync(path.join(generation, "speakers.json")) || !fs.existsSync(path.join(generation, "speakers.npz")))
      throw new Error("active speaker generation is incomplete");
    return { health, text: transcribed.json.text, speakerDir };
  } finally {
    if (first.exitCode === null) first.kill("SIGTERM");
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runLinuxLocalSttSmoke().then(
    (result) => {
      console.info(`[linux-local-stt-smoke] ok text=${JSON.stringify(result.text)}`);
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  );
}
