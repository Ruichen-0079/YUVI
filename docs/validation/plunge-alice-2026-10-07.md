# Plunge/Alice implementation and real-host validation — 2026-10-07

This is an in-progress acceptance record. A working text reply does not imply
that the entire QQ acceptance matrix passed. Raw account configuration, photos,
CDN access URLs and personal model request bodies stay outside Git.

## Baseline and recovery

The [local history audit](plunge-local-audit-2026-10-07.md) records all initial
worktrees, stashes, reflogs, dangling roots, archive hashes/sizes, the recovered
`dbb4b984a2d3354cb96d32943e9fed30035bcaf1`, and 19 local Plunge archive copies with
five distinct variants. Four research originals exactly match the requested
SHA-256 values at tag commit `3dc91f35a0b5037d411a79d4b89e9b7762a09cd1`.
The nested 138,805-byte historical ZIP was actually decompressed and read.
Local user history was backed up and left intact. Main was safely fast-forwarded
to fresh remote `46a24878536d537021c49d50c5ce004d93489628`, then the short-lived
`feat/plunge-alice-20261007` branch was opened. No forced reset or push occurred.

Recoverable commits so far: `c40658a` audit, `f66b4d7` generic Host/publication,
`7956d99` thin QQ/independent Alice, `58e750a` real QQ CDN/context availability,
`e69d003` bounded official DeepSeek Vision. `8d8fc36` preserves the Qwen512 contract after Product adoption.
`c959bbf` implements the generic model-facing context and visual evidence fixes.

## Running environment and model routes

The already logged-in account and SnowLuma 1.14.19 universal OneBot service are
used with its existing authentication. Group 1082590538 and private peer
2198274318 are the authorized acceptance targets. No login/QR/account grant was
bypassed. A simple independent Alice composition owns private env/data and a
separate PostgreSQL schema; the canonical Product Person is shared read-only.
The existing user-owned desktop Yuvi process on 6121 was not restarted or replaced.
An independent modern Yuvi baseline on 6136 and Alice on 6135 coexist.

Alice chat: DeepInfra `deepseek-ai/DeepSeek-V4-Flash-0731`.
Alice Cognition: DeepInfra `zai-org/GLM-5.3-Flash`.
Alice Vision, per explicit user preference: official DeepSeek `deepseek-flash`
(V4.1 Flash), with thinking disabled and bounded output for visual observations.
Local Qwen3 embedding is reused at 512 dimensions. Product-renamed model routes
must preserve the existing Qwen MRL prefix/L2 transform; otherwise the actual
1024-dimensional backend causes keyword fallback. A regression test covers this.

## Real rendered-context inspection

A temporary authenticated loopback forwarding proxy captures the exact actual
ChatModel JSON request without changing the real upstream or model. Full request
bodies are mode 0600 under
`/home/ruichen/.local/share/yuvi/plunge-alice-20261007/rendered-chat-*.json`.
Only inspection conclusions belong here. This is diagnostic instrumentation,
not a permanent model route or an adapter-level prompt.

Initial actual captures 001–006 expose failed live acceptance at 20:54–20:56:

- The group gate saw its scene, current bound sender, real mention, the preceding
  image event and exact image source. It escalated missing perception to Cognition,
  whose capability list did not include the image interface. The resulting answer
  incorrectly said image contents were unavailable despite a retrievable source.
- The private image was processed by routed Vision, but its Character generation
  failed. The next actual private question and final response request had an empty
  source list. The transport observation was being lost on a failed turn.
- New on-demand evidence also needed propagation into Cognition and final Character
  re-entry. A transport receipt or a Vision completion alone proved none of this.

The generic fixes described in [the architecture](../architecture/plunge-alice.md)
address the evidence lifetime, explicit source-selection contract, observation
retention after failure, source descriptors in both gate and final body, scene
relationships and semantic budgeting. Automatic previous-image attachment was
withdrawn; its abandoned patch is retained only in the private audit directory.
Further captures and controlled probes:

- Actual private test at 21:30 reproduced `Character request exceeds the model
working budget` after Vision completed; the following question reached Cognition
  without usable perception. This was a generic late-evidence budgeting defect.
- Native group trace replay initially exposed a mixed NEED_COGNITION/visualNeed
  object. No perception executes for malformed proposals. The existing bounded
  generation repair now asks for one valid, mutually exclusive shape.
- Private replay captures 007–010 use the exact native private image and real
  configured Chat/Vision services in disposable Character/DB state. Vision content
  is present in the gate and final response request; a later question sees an
  explicit source description. Native QQ sends are deliberately disabled.
- Group replay captures 018–020 use the actual original group image and real @
  message. Ordinary image receipt remains OBSERVED; the gate explicitly selects
  its image source, Vision evidence appears in the next gate and final streamed
  request, with sender, mention and original Journal source. No native QQ message
  is sent during replay. This validates model projection, not live transport.
- One separately labeled new outbound diagnostic goes through the real Core gate,
  A9, QQ codec and authenticated SnowLuma HTTP action. Native status=ok, retcode=0
  and message ID are returned; exactly one attempt. This is a controlled probe,
  not a native user inbound and not a retry of a prior UNKNOWN response.

Rendered context must be evaluated together with real model output: receipt,
Vision completion, gate success and final response context are distinct evidence.
Fresh complete live QQ image acceptance remains pending on the final deployed
version; earlier failed attempts are not retrospectively marked passed.

## Acceptance matrix

| Requirement                                         | Repeatable automated evidence                    | Real-host evidence/status                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Shared Person, isolated Alice/Yuvi Memory and state | PostgreSQL multi-Character and Plunge fixtures   | Independent schemas/processes; world QQ conversation rows=0, Alice=21 at inspection; natural Memory cross-retrieval still pending |
| QQ sender → Product Person                          | Host binding and unbound-actor contract          | Actual receipts bind the explicitly granted sender                                                                                |
| Private message / RESPOND                           | Core + native-ACK fixture                        | Earlier real text exchange ACKed and confirmed by user; separate controlled native outbound ACK passed                            |
| Group message as ambient                            | Social + Host fixture                            | Real ordinary group receipts observed without turns                                                                               |
| @Alice is admission, not mandatory reply            | Social + Character fixtures                      | Earlier true @ text responded; quiet request SILENCE observed                                                                     |
| Reply Alice / quote                                 | Observed/conflicting/signed-handle fixtures      | Fresh real quote and rendered relation inspection pending                                                                         |
| Self echo makes no new turn                         | Codec + social fixtures                          | Existing SnowLuma reportSelfMessage=false; actual echo delivery not exercised                                                     |
| SILENCE = zero send                                 | Host + PostgreSQL fixture                        | Real group quiet request logged SILENCE, no send                                                                                  |
| Stale generation after reconnect                    | Real WebSocket fixture                           | Alice restart exercised; stale native ACK injection not yet exercised                                                             |
| Ambiguous send UNKNOWN, no blind retry              | A9 + WebSocket fixture                           | Not yet deliberately induced against actual QQ                                                                                    |
| Temporary-private provenance ≠ send target          | Codec + generic scene fixture                    | No actual temporary-private inbound yet                                                                                           |
| Image → existing visual path → final Chat context   | Core/Character + PostgreSQL selection fixture    | Official Vision API/Core URL smoke succeeds; repaired QQ completion pending                                                       |
| Alice restart leaves Yuvi alive                     | PostgreSQL process contract                      | Repeated Alice restarts; packaged Yuvi remains healthy                                                                            |
| Yuvi desktop path unaffected                        | Existing regression suite + independent baseline | Health checks pass; complete desktop UI interaction still pending                                                                 |

The Vision/Core smoke used an actual prior QQ image and returned an EVA figure
description in 3.9 seconds with official `deepseek-flash`. This is not a substitute
for a fresh QQ response whose final ChatModel request visibly contains that evidence.

## Reproducibility and checks

Use `pnpm check`, `pnpm build` and `pnpm test`. Database suites require a disposable
test role/database through `YUVI_PLUNGE_TEST_DATABASE_URL` /
`YUVI_JOURNAL_TEST_DATABASE_URL`; tests create/drop only their own randomized schemas.
Plunge's PostgreSQL tests use the real Character gate/A9/Memory plumbing with a
scripted non-mock provider and assert exact source selection, final model evidence,
Person isolation, zero-send SILENCE and durable publication certainty.

Final implementation checks pass:

- `pnpm check` and `pnpm build` (logs `check-context-final.log`,
  `build-context-final.log` in the private audit directory).
- `pnpm test`: 3,692 passed, 374 skipped across workspace suites, plus 63 root
  Node checks included in that pass total. Skipped database suites are not counted
  as exercised by the root test command.
- Explicit real PostgreSQL activation: Plunge 6 + multi-Character 2 + outward A9
  17 = 25 passed, zero skipped (`postgres-context-final.log`). Tests create/drop
  only their own randomized schemas.
- Focused source selection, evidence budget with quote/newline-heavy observations,
  identity/current-scene retention, model generation repair, UNKNOWN own-expression
  projection, and Product-renamed Qwen512 regression tests pass.
- Real health checks: existing packaged Yuvi 6121, modern Yuvi 6136 and final Alice
  6135 all return HTTP 200, ok=true. User-owned packaged Yuvi was not restarted.
- Fresh fetch still reports remote main `46a24878536d537021c49d50c5ce004d93489628`
  and the expected research archive commit. Historic worktrees/stashes remain.

Implementation is on the short-lived feature branch. Merge into main is held
until the repaired live image path and the outstanding native acceptance rows
have been assessed. No force push occurred. The exact current HEAD and worktree
state are reported with the final handoff rather than treating pending rows as
complete. Private forwarding/capture instrumentation remains enabled while that
live checkpoint is pending; it must be removed and the original model endpoint
restored after capture is complete.
