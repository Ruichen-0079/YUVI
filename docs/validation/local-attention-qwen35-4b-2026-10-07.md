# Local QQ attention model, 2026-10-07

An independent local Qwen3.5-4B service is installed and running on Ruichen's
workstation. Alice's existing QQ admission and Character path remain active.
The local service has **not** been wired into those paths. This checkpoint
validates model selection, latency and bounded generation, not a production
attention classifier's recall or a new QQ routing policy.

## Artifact and runner

- Community artifact: [Unsloth/Qwen3.5-4B-MTP-GGUF](https://huggingface.co/unsloth/Qwen3.5-4B-MTP-GGUF).
- Hugging Face revision: `86835bf9949e4d14d6860f7910b1340ad4f271a9`.
- Quantization: `Qwen3.5-4B-Q4_K_M.gguf`, 2,834,975,040 bytes.
- SHA256: `3874209241c9a397e2f62cd3f70f80fd2dfbf0dfccb6838416bdb48a714e8630`.
- ModelScope mirror revision: `1225037919bc68d7d510e4e5a46aa84b1ce67cf5`.
  Mirror metadata matched Hugging Face's blob hash and size before downloading;
  the entire assembled artifact passed SHA256 verification.
- Local model: `/home/ruichen/.local/share/yuvi/models/qwen3.5-4b/Qwen3.5-4B-MTP-Q4_K_M.gguf`.
- CUDA llama.cpp: `/home/ruichen/.local/opt/llama.cpp/build/bin/llama-server`,
  commit `7584430716ee229751771ed0d6bbcb780d105eeb`.
- GPU: NVIDIA RTX 5080 Laptop, 16 GB; CPU: Core Ultra 9 275HX.

The existing CPU embedding service, Ollama embedding model and Alice instance
were left running. Before this work there was no local 4B attention model.

## Measured MTP comparison

All four runs used the **same** GGUF and runner, full CUDA offload, flash
attention, 4096-token context, one slot, eight CPU threads, temperature zero,
thinking disabled and identical fixtures. Runs were ordered off, draft length
2, draft length 6, off again. No power-mode or GPU-clock changes were made.

Each run used 16 short uncached attention requests, eight requests with 16 older
conversation entries, eight cached attention requests, and three 128-token
generation requests. Each attention result is a single A/I/U symbol. Latencies
include the HTTP request, prefill and generation. This is a small sequential
benchmark on this workstation, not a concurrency or production traffic test.

| Configuration      | Short median / P95 ms | Longer history median / P95 ms | Cached median / P95 ms | 128-token median ms |
| ------------------ | --------------------- | ------------------------------ | ---------------------- | ------------------- |
| MTP off, first run | 72.85 / 73.42         | 147.67 / 153.18                | 54.14 / 83.31          | 961.93              |
| MTP draft length 2 | 105.89 / 112.48       | 181.27 / 192.09                | 82.22 / 112.07         | 759.50              |
| MTP draft length 6 | 112.17 / 125.14       | 191.23 / 198.05                | 82.75 / 113.44         | 964.05              |
| MTP off, repeat    | 72.85 / 77.33         | 141.90 / 146.81                | 52.13 / 83.19          | 951.55              |

Draft length 2 improved this longer generation by about 1.27x versus the first
off run. The worker also recorded 69 accepted / 116 drafted tokens (59.5%) and
mean accepted sequence length 2.19. It made the two-token attention workload
slower. Length 6 did not improve this workload. The selected attention service
therefore runs **MTP off**, with prompt caching enabled. The artifact retains its
MTP head for other experiments; no advertised 1.5–2x gain is assumed here.

Across the 128 attention comparison requests, every result had exactly two
completion tokens and no reasoning body. The fixture set covers private chat,
true mention, reply, own message, other participants' conversation, missing
addressing metadata, prompt injection, and current vision evidence following
an older assistant refusal. In longer/cached runs, one private fixture switched
from A to U; both hand off to Character. These fixtures are not a calibrated
recall evaluation.

## Generation constraints and fallback

The intended caller endpoint is `POST http://127.0.0.1:8130/attention`. It accepts
only `{ "context": "..." }` and a bearer key. Key material is stored outside the
repository with permissions 0600 and is never logged.

The gateway constructs every model request itself:

- `chat_template_kwargs.enable_thinking = false`, `reasoning_budget_tokens = 0`.
- Both `max_tokens` and `n_predict` equal 4; neither is caller configurable.
- Grammar: `root ::= "A" | "I" | "U"`. The model's answer is exactly one symbol.
- A maps to ATTEND, I to IGNORE, U to UNCERTAIN. U hands off to Character.
- Nonempty reasoning, malformed output, token overflow or an incomplete
  completion is rejected and becomes UNCERTAIN with handoff enabled.
- Timeout is 1500 ms. Model errors and an occupied slot also hand off rather
  than queueing or suppressing the current event.
- Oversized context is handed off without truncating current information.
  The optional prefilter has a 6000-character input limit; the model's token
  context limit can also reject a request, which follows the same fallback.

The raw worker's OpenAI-compatible API on 8129 is for model diagnostics. Its
`--predict 4` flag is a default, not an immutable cap: the **8130 gateway** is the
bounded application contract. A future runtime integration must handle gateway
unavailability with the same handoff behavior, and preserve canonical direct
addressing, identity and own-event rules outside the small model.

The actual rendered chat template was inspected through `/apply-template`.
Its assistant prefix ends in `<think>\n\n</think>\n\n`: the thinking segment is
already closed before generation. This uses the [official non-thinking API
switch](https://huggingface.co/Qwen/Qwen3.5-4B), rather than a `/nothink` prompt.
The [llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
documents template parameters and grammar constraints.

## Installed services and live service checks

Two enabled user services are running:

- `yuvi-local-attention-model.service`: worker on loopback 8129, CUDA offload,
  flash attention, one slot, MTP off, reasoning off and zero reasoning budget.
- `yuvi-local-attention.service`: bounded Node gateway on loopback 8130,
  implemented by `scripts/local-attention.mjs`.

After installation, 40 HTTP requests to the **running gateway** exercised the
eight fixture classes five times. All 40 handoff outcomes matched the fixtures;
none used error fallback. Median end-to-end latency was **55.65 ms**, P95
**59.89 ms**, with two completion tokens throughout. Three attempts to raise
the token limit or enable thinking were rejected with HTTP 400. A 6001-character
input immediately returned UNCERTAIN / handoff=true without slicing it.
Total workstation GPU memory usage after loading was about 5359 MiB including
the desktop and preexisting GPU consumers, versus about 2022 MiB before loading.

Five focused Node tests passed: fixed constraints despite injected text,
strict response validation, oversized-context handoff, model failure/timeout
handoff, and HTTP rejection of parameter overrides. `pnpm check` and `pnpm build`
passed. Alice was not restarted for this deployment, and no QQ message was sent
by this service. Existing QQ live acceptance evidence is recorded separately in
[the Alice validation](plunge-alice-2026-10-07.md).

## Local evidence and operation

Evidence directory: `/home/ruichen/.local/share/yuvi/local-4b-20261007/`.

- `deployment-manifest.json`: pinned model and runner identity, selected mode.
- `mtp-metadata.json`, `download-mtp.log`: source identity and SHA verification.
- `benchmark.mjs`, `benchmark-results.json`, `benchmark-summary.json`:
  reproducible A/B script, actual model responses and latency measurements.
- `worker-off-1.log`, `worker-mtp-2.log`, `worker-mtp-6.log`, `worker-off-2.log`,
  `metrics-*.txt`: actual prefill/decode timings and speculative acceptance.
- `attention-rendered-request.json`: bounded request and actual rendered prompt.
- `live-smoke.mjs`, `live-smoke-results.json`: installed service checks.
- Unit-file copies and `pnpm-check.log`, `pnpm-build.log`.

Operational checks:

```sh
systemctl --user status yuvi-local-attention-model.service yuvi-local-attention.service
curl http://127.0.0.1:8130/health
node --test scripts/local-attention.test.mjs
```

The health endpoint reports the gateway's availability and fixed limits;
model-call failures remain explicit fallback results. User services start with
the user's systemd session. No system-level boot/linger settings were changed.
