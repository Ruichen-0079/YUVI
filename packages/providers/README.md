# @companion/providers

Provider interfaces, registry, and future implementations.

Responsibilities:

- Define provider capability interfaces.
- Register concrete providers outside runtime core.
- Normalize provider errors.
- Keep vendor clients behind stable abstractions.
- Keep provider-specific response shapes out of runtime core.

Provider families currently supported by the registry:

- DeepSeek chat and reasoning.
- xAI TTS and vision.
- Alibaba Cloud DashScope STT.
- OpenAI-compatible chat, reasoning, vision, and embedding routes for
  compatible or local gateways.
- GPT-SoVITS TTS for local development.
- Embedding providers for memory retrieval.

Explicit mock providers are available for tests and offline development when
`PROVIDER_ALLOW_MOCKS=true`; real provider routes are never silently relabeled
as mocks.

## Type Layout

- `src/types/common.ts`: shared health, metadata, token usage, and message types.
- `src/types/chat.ts`: chat provider contract.
- `src/types/reasoning.ts`: reasoning provider contract.
- `src/types/tts.ts`: text-to-speech provider contract.
- `src/types/stt.ts`: speech-to-text provider contract.
- `src/types/vision.ts`: vision provider contract.
- `src/types/embedding.ts`: embedding provider contract.
- `src/types/errors.ts`: normalized provider errors and call-error policy
  (`retryable`, `fallbackEligible`, `effectState`). Replay and provider-hop
  safety require `effectState === "not_started"`; `unknown` is not evidence
  that the earlier invocation did not apply. `ProviderRouteStatus.fallbackEligible`
  remains a route/readiness projection and is a different concept.

## Provider contracts

Provider contracts are capability-specific and are resolved through the
existing `ProviderRegistry` / `ProviderResolver` boundary. A provider adapter
must return the normalized business result for its capability rather than
vendor transport fields.

Chat streaming is selected by method: `generateReply()` is always a
non-streaming operation and `streamReply()` is the authoritative normalized
streaming operation. The legacy `ChatInput.stream` field is retained only for
compatibility and must not turn `generateReply()` into a streamed transport
request. Normalized streams contain non-empty `text-delta` events followed by
exactly one `completed` event; the completed message content must equal the
concatenated deltas. Provider-native transport frames, internal reasoning, and
tool/function-call events are not exposed above the provider boundary.
`FallbackChatProvider.streamingMode` is a diagnostic projection of the
preferred route, not a chain-wide capability guarantee; stream execution
evaluates each configured route as it is attempted.

Reasoning has one authoritative business result: `ReasoningOutput.answer`.
The legacy `ReasoningOutput.reasoning` field remains for structural
compatibility, but is not a raw provider reasoning/internal-trace channel and
normalized adapters leave it empty. Raw vendor reasoning content is discarded
at the provider boundary. `packages/memory/src/extractor.ts` remains
answer-first and is not changed.

The current Runtime does not implement tool/function calling. `role: "tool"`
and `finishReason: "tool_call"` remain reserved compatibility values only;
they do not provide normalized tool definitions, calls, results, streaming
argument deltas, or execution.

Provider status has two independent axes. `readiness` is local configuration
state (`ready` or `not_ready`) based on required local fields being present;
it does not validate endpoint syntax or remote reachability. It is the only
state used to decide whether a provider route can be constructed. `observed` is
cached explicit live-verification state (`unknown`, `available`, `degraded`, or
`unavailable`). A configured provider starts with `readiness: "ready"` and
`observed: "unknown"`; config inspection never claims remote availability. The
legacy `available` field is retained as a compatibility projection of local
readiness, not remote health.

`ProviderRegistry.getStatus()` is synchronous, local, and zero-I/O. It never
calls a provider `healthCheck()` or a remote endpoint. Only explicit live
verification updates the in-memory observation cache. The cache belongs to one
`ProviderRegistry` instance; runtime settings reload replaces that instance,
so observations reset and are not persisted or copied across reloads. Config-
only verification for TTS, STT, Vision, and provider chains reports
`verificationMode: "config_only"`, leaves `observed` unchanged, and marks
uninvoked chain routes as `skipped` rather than `success`. Live chat, reasoning,
and embedding verification are the explicit provider-I/O paths and may incur
provider usage or billing. Ordinary `/health` is also zero-provider-I/O and
exposes readiness and cached observation separately; service operability from
local readiness is not proof of remote reachability.

## STT contract (P7-5)

STT is currently a batch capability. The stable provider contract is:

```ts
STTProvider.transcribeAudio(
  input: STTInput,
  options?: ProviderCallOptions
): Promise<STTOutput>
```

Provider-level input supports `audioUrl`, `audioBase64`, `audioBuffer`, the
compatibility alias `audio`, and `localFilePath`. DashScope resolves multiple
supplied sources in this order: `audioUrl`, `audioBase64`, `audioBuffer`,
`audio`, then `localFilePath`. `audio` and `audioBuffer` remain compatibility
aliases; P7-5 does not add provider-level mutual-exclusion validation.

`providerMetadata.sourceKind` describes the source actually selected by that
resolution. Selection and source classification are one operation.

DashScope-specific input checks remain adapter boundaries: inline audio has an
adapter-owned size limit, zero-byte audio is rejected, relative local paths
are rejected, and MIME inference for local files remains adapter behavior.
There is no new global or vendor MIME allowlist.

Successful STT output requires meaningful non-empty transcript text. The
normalized adapter output may include language, confidence, and usage when
available. `segments` and timestamp fields remain optional capability space;
the current adapter does not fabricate them.

`ProviderCallOptions.signal` is the canonical caller-owned cancellation
channel. Future streaming STT must be additive through a separate interface
and capability; `transcribeAudio()` is not a streaming operation. P7-5 adds
no streaming DTOs, WebSocket transport, or streaming protocol contract.

## TTS contract (P7-6)

TTS is currently full-buffer synthesis:

```text
one request -> one provider synthesis -> complete buffered audio -> one TTSOutput
```

The stable provider contract is:

```ts
TTSProvider.synthesizeSpeech(
  input: TTSInput,
  options?: ProviderCallOptions
): Promise<TTSOutput>
```

`ProviderCallOptions.signal` is the canonical cancellation channel. The
deprecated `TTSInput.signal` is compatibility-only and must not be used by new
callers. `TTSOutput.audio` and `TTSOutput.mimeType` are required; optional
`audioBuffer` and `audioBase64` representations must contain the same bytes.
Duration, sample rate, and channel metadata are not promised unless supplied.
No public streaming TTS contract exists. Future streaming must be additive and
must not silently replace `Promise<TTSOutput>`.

GPT-SoVITS adapter support is explicit and does not include transcoding:

| Yuvi format | wrapper     | wrapper-fallback | API-v2                       |
| ----------- | ----------- | ---------------- | ---------------------------- |
| mp3         | unsupported | unsupported      | unsupported                  |
| wav         | supported   | supported        | supported                    |
| opus        | unsupported | unsupported      | unsupported                  |
| pcm         | unsupported | unsupported      | supported via upstream `raw` |
| mulaw       | unsupported | unsupported      | unsupported                  |
| alaw        | unsupported | unsupported      | unsupported                  |

Wrapper speed is unsupported. API-v2 maps the existing speed option to
`speed_factor`. xAI supports its configured format set.

## Vision contract (P7-7)

Vision is a one-shot/full-result capability:

```ts
VisionProvider.analyzeImage(
  input: VisionInput,
  options?: ProviderCallOptions
): Promise<VisionOutput>
```

No public Vision streaming contract exists. Future streaming, video, or
camera analysis must be additive.

Provider source precedence is deterministic and does not require mutual
exclusion:

```text
imageUrl -> imageBase64 -> imageBuffer -> image -> localFilePath
```

Only the selected source is validated; lower-precedence values are ignored.
The xAI adapter accepts `image/png` and `image/jpeg`, with `image/jpg`
normalized to JPEG. It rejects unsupported inline/local formats and does no
transcoding. `localFilePath` is trusted-internal capability only.

The public route exposes only `imageUrl -> imageBase64`; both may be present
and the URL wins. Public URLs are limited to HTTP/HTTPS and are forwarded to
the external provider without Yuvi downloading them. Raw base64 requires
supported MIME metadata and valid non-empty base64. Supported image data URLs
may also be passed through `imageBase64`. Invalid public image input returns
HTTP 400 before provider work.

Inline and local adapter inputs are limited to 20 MiB of raw/decoded image
bytes. The public JSON request is also subject to the server HTTP body limit,
and remote URL size is enforced by the upstream provider rather than by a
Yuvi download.

`ProviderCallOptions.signal` is the canonical cancellation channel. The
public route maps request/socket disconnect to that signal through the
fallback chain and concrete provider, does not treat normal request-body
completion as disconnect, cleans listeners, and suppresses late HTTP success.

`VisionOutput.text` must contain meaningful analysis. Labels, objects,
confidence, scene summary, model/provider metadata, and token usage are
optional; the current xAI adapter uses `sceneSummary = text` only as a
compatibility projection and does not fabricate the other semantic fields.
Raw provider debug data remains internal/opt-in and is not returned by the
public route. The current public flow is transient and does not persist image
bytes to conversation or memory.
