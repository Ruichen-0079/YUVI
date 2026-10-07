# YUVI

[English](README.md) | [简体中文](README.zh-CN.md)

**A local-first personal AI companion built for long-term interaction.**

YUVI brings conversation, voice, long-term memory, identity-aware context, Live2D presentation and desktop presence into one persistent companion system.

Its focus is not to become the largest AI character platform or a general-purpose computer agent. YUVI is being built around a narrower question: **how can an AI companion remain useful, recognizable and reliable over long periods of personal use?**

<!-- Add a current product screenshot / short demo here. -->

## Current Release

**YUVI v0.1.2** is the current public release.

- Linux x86-64 installer: `yuvi-v0.1.2-linux-x64-installer.run`
- Linux x86-64 portable build: `yuvi-v0.1.2-linux-x64-portable.tar.zst`
- Release notes and checksums: https://github.com/Ruichen-0079/YUVI/releases/tag/v0.1.2-final

Linux is the current primary release and validation target. Windows remains a supported development and packaging target, but does not yet have the same public release path.

## What YUVI Can Do Today

### Conversation and cognition

- Persistent text conversation through the YUVI Runtime.
- Configurable Chat, Reasoning, Embedding, STT, TTS and Vision capability routes.
- Provider fallback without coupling Runtime behavior to a single vendor.
- Explicit image / vision use through configured providers rather than continuous screen monitoring.

### Voice

- Speech-to-text and text-to-speech integration.
- Packaged Local STT support in the Linux release.
- Voice and speaker-profile management for personal use.
- Speaker matching and diarization remain experimental and are not authentication mechanisms.

### Memory and people

- Durable conversation persistence and long-term memory.
- PostgreSQL + pgvector as the validated durable storage path.
- Evidence-based person/profile context rather than hidden inferred persona truth.
- Memory retrieval, maintenance, expiry and supersession support.

### Desktop companion experience

- Live2D desktop presentation.
- Direct import of user-provided VTube Studio ZIP packages.
- Transparent Companion and Subtitle desktop surfaces.
- Window placement, visibility, always-on-top and lock/unlock controls.
- System tray controls.
- Guided first-run setup.
- English and Simplified Chinese product UI.

### Reliability

YUVI treats long-running behavior as a product requirement rather than an implementation detail. The Runtime preserves explicit lifecycle ownership, durable turn handling, idempotency, retry/reconcile behavior, crash recovery, cancellation fencing and fail-closed boundaries around ambiguous external effects.

## Product Direction

YUVI is organized around five long-term product concerns:

- **Character** — a recognizable and stable identity rather than a disposable prompt.
- **Conversation** — natural text and voice interaction.
- **Memory** — durable personal context with explicit evidence and ownership.
- **Perception** — obtain environmental information when it is actually needed.
- **Runtime** — decide, execute and recover reliably over long periods of use.

Live2D, subtitles, voice and the WebUI are presentation surfaces around that core rather than separate sources of behavioral authority.

## How It Fits Together

```text
                       +------------------+
                       |  Memory / People |
                       +---------+--------+
                                 |
Text / Voice / Image --->   YUVI Runtime   <--- Providers / Models
                                 |
                    +------------+------------+
                    |            |            |
                    v            v            v
                Character    Perception    Actions
                    |
                    v
             Desktop Presence
          Live2D · Voice · Subtitle
```

The Runtime owns execution lifecycle and canonical state transitions. Presentation layers do not bypass it.

## Local-First and Privacy

YUVI is **local-first**, not necessarily fully offline.

Runtime state, local configuration and supported personal data paths are designed to remain under the user's control. Cloud-backed providers can still be configured for Chat, Reasoning, STT, TTS, Vision or Embedding; when they are used, the relevant request data is sent to those providers according to their own policies.

Current Vision behavior is explicit and one-shot. YUVI does not require continuous desktop screenshot monitoring.

Secrets must stay in local configuration and must not be committed to the repository or emitted through logs, events or error payloads.

## Getting Started

### Use the released Linux build

Download **v0.1.2** from:

https://github.com/Ruichen-0079/YUVI/releases/tag/v0.1.2-final

The Linux x86-64 release currently targets Debian 12 / glibc 2.36 and expects the system GTK/WebKitGTK 4.1 and AppIndicator runtime libraries. Some provider credentials, models and local services still require configuration.

Live2D Cubism Core and proprietary character assets are not bundled.

### Develop from source

YUVI is Linux-first for development and production-like validation.

Requirements include Node.js, pnpm, Docker/Compose for development infrastructure, and PostgreSQL + pgvector for the durable persistence path.

```bash
pnpm install
cp .env.example .env
./scripts/dev.sh
```

Development endpoints:

- Server: `http://localhost:6121`
- Web UI: `http://localhost:5173`
- WebSocket: `ws://localhost:6121/ws`

Useful commands:

```bash
pnpm check
pnpm test
pnpm build
pnpm smoke
pnpm db:migrate
pnpm smoke:postgres
```

See [Quick Start](docs/quickstart.md) and [Linux daily use](docs/linux-daily-use.md) for the current setup and lifecycle details.

## Repository Structure

- `apps/server` — Fastify HTTP/WebSocket Runtime server and composition root.
- `apps/web` — Product WebUI.
- `apps/desktop` — desktop presentation shell where applicable.
- `packages/core` — Runtime orchestration and behavioral integration.
- `packages/memory` — durable conversation and long-term memory boundaries.
- `packages/providers` — provider contracts, registry and vendor adapters.
- `packages/prompt-builder` — provider-neutral prompt assembly.
- `packages/protocol` — runtime events and schemas.
- `packages/config` — typed configuration and redaction boundaries.
- `docs/future` — future architecture and product planning; not a statement of implemented behavior.

## Engineering Principles

- **Runtime owns execution.**
- **Memory is evidence, not hidden persona truth.**
- **Providers are replaceable.**
- **Reliability semantics are product assets.**
- **Prefer small, behavior-preserving changes over speculative architecture.**

These rules exist to keep one long-lived companion from turning into several competing lifecycle or state authorities.

## Research Direction

YUVI is also intended to serve as an experimental platform for long-term human-AI interaction.

Current areas of interest include:

- **Anthropomorphic conversational models** — making companion dialogue more natural, socially expressive and character-consistent instead of merely assistant-like.
- **Personalized attention policies** — learning when a persistent companion should observe, remain silent or initiate interaction.
- **Long-term identity and relationship continuity** — preserving coherent personal context over extended use.

These are research directions, not claims that YUVI has already solved them.

## Roadmap

Near-term work remains deliberately product-focused:

```text
reliability
  -> desktop closure
  -> UX simplification
  -> documentation
  -> stable releases
  -> deeper companion intelligence
```

Future architecture documents live under [docs/future](docs/future/). Their decisions do not by themselves imply implementation; [the implementation baseline](docs/future/implementation-baseline.md) records accepted reality. [A10.1 aggregate Memory/Profile closure](docs/validation/v0.1.3-a10.1f3-aggregate-memory-profile-closure.md), [A9.1 atomic intent/outbox admission](docs/validation/v0.1.3-a9.1-atomic-effect-intent-outbox.md) and [A9.2 durable dispatch accounting](docs/validation/v0.1.3-a9.2-dispatch-reconciliation-crash-ambiguity.md) are implemented. A9.2 activates bounded local read-text only; unsupported reconciliation remains UNKNOWN. A9.3/aggregate A9, A10.2/A10.3/aggregate A10 and A11.1/A11.2 are implemented within their validated boundaries. A12 remains open. `main` is the authoritative development trunk; this does not announce a new public release.

Current development on `main` includes [Multi-Character Core](docs/architecture/multi-character.md): independent Character compositions share Product Person and model services while isolating Memory and perspective. [Validation](docs/validation/multi-character-2026-10-07.md) records durable/restart acceptance; complete Linux packaged conformance remains blocked by native PG16 packaging prerequisites. Desktop selection and QQ integration remain future work.

## Inspirations

YUVI was initially inspired in part by the ambition of [Project AIRI](https://github.com/moeru-ai/airi) and the broader open AI VTuber / companion ecosystem.

YUVI is an independent implementation and has since developed around a different emphasis: persistent personal companionship, continuity, local-first operation and Runtime reliability.

## License

See the repository license for the terms that apply to YUVI source code and bundled assets. Third-party models, Live2D Cubism components and character assets may have separate licenses.
