# Local CPU STT (sherpa-onnx)

Lifecycle is owned by the existing DesktopSupervisor service model.
Runtime transcription stays in `packages/providers` (`LocalSTTProvider`).

Quick OSS pick: sherpa-onnx covers ASR + speaker embedding + diarization on CPU.
whisper.cpp is strong for transcription but needs extra speaker models; vosk is older.

Development provisioning (runtime and weights stay on disk, not Git):

```bash
pnpm local-stt:provision
```

Default bind: `127.0.0.1:9876`. Threads cap at `min(4, nproc/4)`.
`CUDA_VISIBLE_DEVICES` is forced empty.
The desktop microphone path converts browser recordings to mono 16 kHz WAV before
upload, so the packaged sidecar does not depend on a system `ffmpeg` install.

To let DesktopSupervisor own the sidecar process in development, configure the
provisioned command; without it the service remains observe-only:

```bash
LOCAL_STT_BASE_URL=http://127.0.0.1:9876
YUVI_LOCAL_STT_START_COMMAND=/path/to/local-stt/.venv/bin/python services/local-stt/server.py --model-dir /path/to/local-stt/models --yuvi-local-stt
YUVI_AUTOSTART_LOCAL_STT=false
```

Packaged Windows and Linux public installs carry a self-contained CPU sidecar
and the verified model tree. DesktopSupervisor derives its command from the
packaged `local-stt/local-stt-manifest.json`; it never calls Python, uv, or a
developer checkout, and `YUVI_LOCAL_STT_START_COMMAND` is not required.

SenseVoice **weights** are redistributed under the FunASR Model License v1.1,
not Apache-2.0. See `THIRD_PARTY_NOTICES.md`.

To select the sidecar for Runtime STT, also set
`LOCAL_STT_BASE_URL=http://127.0.0.1:9876` and
`LOCAL_STT_MODEL=sense-voice-zh-en-ja-ko-yue-2024-07-17-int8`.

Speaker profiles (`YUVI_STT_SPEAKER_DIR`, default `<model-dir>/speakers`):

- `speaker-manifest.json` — active revision, file digests and command fences/receipts, file mode `0600`
- `generation-<revision>/speakers.json` — metadata only, file mode `0600`
- `generation-<revision>/speakers.npz` — acoustic embeddings, file mode `0600`

Enrollment and deletion use the host's governed command, fence and reconciliation
protocol. Metadata and vectors are written and fsynced as one generation before
the manifest activates them. Legacy root-level files migrate into the first
generation on startup; incomplete generations are never current.

Persisted `speakerId` is the acoustic template identity (`voiceProfileId`), not
a person id. HTTP JSON never includes embedding vectors; delete retires the
active generation's metadata row and vector together. Identify is fail-closed: cosine score below
threshold returns `NO_MATCH` / `UNKNOWN`. Mixed diarized captures are matched
per cluster; a whole-audio template match is never applied to every speaker.

Local STT uses `LOCAL_STT_BASE_URL` exclusively. `LOCAL_MODEL_BASEURL` remains the independent OpenAI-compatible Chat/Reasoning endpoint; migrate old STT configuration to the dedicated key.
