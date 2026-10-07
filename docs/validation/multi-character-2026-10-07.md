# Multi-Character Core acceptance, 2026-10-07

Baseline was fresh-fetched twice: development branch
`codex/v0.1.3-platform-completion-20260922` remained at
`94e20d0ceb63b127781ed66f60337ac655820001`. Implementation lives on
`codex/multi-character-core-20261007`. See the [ownership and deployment
contract](../architecture/multi-character.md).

The implementation uses immutable authored Character binding plus independently
constructed existing Runtime/host graphs. It does not introduce a manager of
multiple personalities inside RuntimeOrchestrator, a second Journal/Memory, or
shared autobiographical records. New Character instances have reserved Memory
scopes and private repository views, roots and durable owner metadata. Legacy
primary Yuvi keeps its authored persona and existing scope encodings and bytes.

## What the acceptance actually proves

`apps/server/src/multi-character.integration.test.ts` uses real PostgreSQL 16
with pgvector and the existing production context factory. It creates unique
private schemas in one shared PostgreSQL daemon, then constructs Yuvi and Alice
simultaneously. Both resolve `person:chen` through a read view of the **same
actual Product Person file**. That view excludes primary persona selectors and
private notes. The compositions use equal session IDs and subject IDs.

Each Character admits a different source through the existing conversational
Journal receipt boundary and writes a grounded relationship Memory through the
existing Memory candidate admission path. The test checks actual lineage,
rejects foreign Character retrieval parameters, then verifies returned contents
and durable record IDs: Yuvi → A, never B; Alice → B, never A. Private sessions
restore only their own text after shutdown/reconstruction. Shared Person does
not grant Memory or relationship access.

A real host-protected P8 command follows existing CONTROL/A9/native-owner
handling. Its exact resulting revision survives reconstruction; Alice rejects
that correction's owner and cannot resolve its revision. Private proactive
suppression survives reconstruction without crossing compositions. The test
keeps production consent projection authority intact; it does not claim that
untrusted consent can be restored from a policy file.

Wrong file-root reuse, an active database writer collision and a durable
mismatched database owner are rejected. The database owner is claimed before
bootstrap/recovery starts. Runtime graph construction rejects sharing mutable
repositories, event buses and Registries between Characters.

The second acceptance starts **two actual built server worker processes** using
`YUVI_CHARACTER_CONFIG_PATH`. It reads their health identity and durable Memory
through their HTTP surfaces, kills one with SIGKILL, reopens it and verifies the
other process/history stayed unchanged. The restarted worker restores its own
conversation and retains its owner. It does not start a model stack.

`packages/core/src/multi-character.test.ts` captures the actual semantic input
to the Character port and asserts different authored Identity/Persona. It also
runs concurrent in-flight turns, aborts Yuvi's turn and observes Alice's signal
remaining active. P8 outage semantics remain unchanged: an unavailable
correction owner is not silently converted into a successful reconstruction.

`packages/memory/src/character-scope.test.ts` covers foreign read/write/Profile
requests, unscoped explicit-instance provider calls, foreign backend events,
repository rebinding and preserved old primary aliases. The existing Mem0
provider/backend/service tests also run; this is not a claim of live Mem0
sidecar multi-instance load testing.

`packages/providers/src/multi-character.test.ts` uses two independently owned
Registries, equal session scope, separate accounting adapters and concurrent
calls to one real HTTP serving endpoint. It rejects Registry owner switching,
accounting owner switching and sharing one owner-bound accounting adapter.
Bootstrap configuration is not mutated to change a caller's owner. An opt-in
run additionally calls **one actual Qwen3-4B Q4_K_M llama.cpp process**, one
serving slot, through both Registries. This validates serving/accounting reuse;
it is not a personality-quality or attention-router benchmark.

## Validation and release boundary

- `pnpm check`: passed, including workspace TypeScript and host environment safety.
- `pnpm build`: passed, including pinned offline fonts. This cloud environment
  needs Node's environment proxy enabled for initial font acquisition; no source
  network workaround or runtime font dependency was added.
- Full `pnpm test` with PostgreSQL and actual-model opt-in: **3,898 Vitest tests
  and 63 Node tests passed; zero failures**. Fifty-six prerequisite-dependent
  tests skipped: five native PostgreSQL Supervisor lifecycle tests, three live
  Mem0 Profile tests, 33 voice-control Journal ingress tests, eight canonical
  evidence admission tests and seven live grounded Finalized/Mem0 tests. The new
  multi-Character database/process tests and actual-model test all ran. PostgreSQL
  tests use task-owned schemas, not production data.
- Existing release conformance PostgreSQL tests and outward transport accounting:
  55 tests passed together with the new durable/process acceptance.
- Conformance owner inventory includes Character binding, scope/access view,
  composition/storage and the corresponding acceptance files.
- `pnpm test:conformance`: attempted; preflight stopped on missing
  `YUVI_POSTGRES_HOME`. This environment has Docker PG16/pgvector for durable
  tests, but no staged native PG16 distribution, Linux Mem0 packaging Python or
  the gate's pinned Node 24.20.0. The installed Node is 24.19.0. The complete
  packaged Linux release gate is **not certified** by this change.

An initial final workspace attempt opted into the model test after its earlier
long-lived test service had exited. That run failed with NETWORK_ERROR. The
verification script now owns model startup/readiness/shutdown for the whole
run. No provider retry, accounting bypass or production behavior was changed
for that fixture failure.

The default desktop bootstrap/UI/Supervisor remains the primary Yuvi path. A
roster supervisor and Character selector, shared voice binding administration,
QQ principal resolution and physical presentation multiplexing are subsequent
consumer/deployment work. Workers omit global Product/People/service-control
writers. Core reuses authored definitions and private graphs; Plunge should bind
a QQ surface to the Alice graph rather than replace Yuvi's persona in place.

Historical overlay data cannot be attributed to a new Alice instance merely
from prompt text. Existing primary data is preserved; any future historical
reassignment needs explicit evidence and migration, not shared Memory access.
No real QQ account or production QQ message was used.
