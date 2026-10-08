# Plunge ZIP WebUI acceptance — 2026-10-08

Baseline was the clean `360afba` Alice Persona branch, not old main. Work is isolated in `feat/plunge-webui-20261008`; main is not merged. No `apps/web` source changes or Core implementation changes are included. The server's Character adapter only adds an exact RESPONSE_REQUIREMENTS audit span; model-facing text is unchanged.

## Interface scan and implementation boundary

Alice owns its existing composition/environment, database schema and Character persona. Provider Registry and the existing Product configuration parser, persistence/revision checks, Journal configuration admission and Runtime reload are reused with an explicit Alice environment; shared Product Person editing routes are omitted. Character bootstrap keeps both Memory persona and configured subject pinned during reload. Model application shares the QQ ingress queue boundary.

Memory repository/retrieval reads, Finalized non-terminal records, Dream due jobs/by-ID and ingestion diagnostics use existing services. Direct-table Memory CRUD/maintenance writes are blocked on this management host, including query-string variants. Semantic correction uses the extracted, unchanged existing protected P8 handler: preflight, native owner revision, Journal/A9 command, dispatch permission, native correction receipt. The normal correction form names the existing `relationship.current` target and real granted Person/Character scope; advanced records remain subject to Core's invariant and isolation checks. Authored fixed persona and generated context are read-only.

QQ controls are actual admission branches, continuation duration, opportunity cooldown (up to the existing 120-second scene lifetime), native quote segment, and saved allowlists. No synthetic activity score or unwired proactive-send control exists. Candidate admission can still yield SILENCE.

Inspector observes the real ChatModel methods and slices existing submitted text by producer offsets. It never assembles another prompt. It also shows actual response authorization/disposition and failure codes. Request copies are memory-only and evicted whole, with at most 12 requests. Historical conversation in native QQ is part of CURRENT_SITUATION; Cognition/Vision appear only when actually present. HTTP adapter defaults are distinguished from ChatInput metadata.

## Automated verification

- `pnpm --filter @companion/server... build`: passed. Final targeted server TypeScript rebuild passed.
- Server suite: **584 passed, 221 skipped**. Skips are reported, not counted as exercised.
- Explicit PostgreSQL Plunge, multi-Character and outward-transport activation: **27 passed, zero skipped**, using randomized disposable schemas. This includes Vision evidence through final input, zero-send SILENCE, UNKNOWN with one send attempt, isolated Memory/P8 and independent process restart.
- Focused new checks cover scoped model persistence versus the world environment, actual adopted route projection, pinned subject, revision conflict, token/Origin/Host/remote access, direct CRUD rejection, exact prompt copies, stream transparency, error/decision inspection, cooldown, initial reconnect, stale generation, replay after lost ACK, and applying configuration between turns.
- Host environment safety and `git diff --check`: passed.

## ZIP and browser verification

Built a standalone Linux x64 ZIP with bundled Node 24.20.0, bundle syntax/external-module audit, Node license/notices, static assets and launcher. Actually extracted it outside the repository, preserved executable modes and launched the existing Alice configuration from that directory. The final runtime was restarted from the updated ZIP; QQ became READY and saved model state remained ACTIVE at revision 3. ZIP contains no deployment files, tokens, conversations, database or node_modules. The original Alice launch information was backed up privately before changing processes; runtime environment came from its existing private files. The existing packaged Yuvi on 6121 remained healthy.

A visible Chromium window inspected all six real Alice pages at 1440 px and the mobile layout at 390 px: no page script errors or horizontal overflow. The browser exercised invalid model configuration feedback, successful model save/apply, allowlist pending-restart state after refresh, restoration before restart, and token clearing on page reload. Browser offline mode during a write attempt showed an unknown-outcome message, automatically recovered read access, and made **no automatic write retry**.

Delivered screenshots use real rendered pages with DOM-level privacy masking before capture; raw screenshots, account/Person IDs and conversations stay outside Git. The Prompt screenshot selects the actual native final streaming request captured before the final observability/reconnect update; no historical request is injected into the new process. Restart empties the Inspector by design.

## Real Alice acceptance

- State/QQ/Memory/model/pipeline reads succeeded with the management token.
- Chat temperature was changed, saved and applied through the existing configuration route, read back, then restored. Browser also saved the restored configuration. No embedding space or model route was changed by acceptance.
- QQ opportunity cooldown was changed, observed in the active policy, and restored. Removing the saved group allowlist showed RESTART_REQUIRED while the active grant remained intact; it was restored before restart.
- Existing correct Alice relationship was read and resubmitted through the P8 protected route, receiving STORED plus a Journal receipt. This idempotent resubmission introduced no new fictional relationship or Memory evidence.
- User-supplied group quiet request yielded **SILENCE, zero sends**.
- First native private probe hit an HTTP 502 at the pre-existing model endpoint. This was recorded as FAILED/PROVIDER_UNAVAILABLE. A separate live Chat check then succeeded.
- User's follow-up private probe yielded **RESPOND and exactly one native ACK**. Inspector's complete final message array matched the independently captured actual HTTP model request byte-for-byte after JSON decoding. It included IDENTITY, PERSONA, RELATIONSHIP_CONTEXT, MEMORY_EVIDENCE, CURRENT_SITUATION, current message and authored RESPONSE_REQUIREMENTS. Full bodies remain private.
- A later private probe returned HTTP 200 with **authorization NONE → SILENCE**. This is explicitly distinct from a network failure and was not retried or forced to reply. Persona/Character decision policy is preserved.
- On the final ZIP, authenticated manual QQ reconnect changed generation, restored READY and made **zero native sends**. Socket tests separately prove lost ACK/UNKNOWN is never resent and complete recent native input replay cannot trigger another send.

QQ reconnect now also recovers from initial unavailability, with 0.5-second to 30-second backoff. It retries connection/handshake only, never publication or Character turns. The reliable input fingerprint guard retains at most 256 recent native identities across reconnect in the same process; it is bounded and not a claim of unlimited cross-process exactly-once delivery. Browser reconnect is read-only. Model 502 failures and genuine Character SILENCE remain observable rather than blindly replayed.

Private verification artifacts are under the operator-owned `plunge-webui-verification` state directory. Final ZIP path, SHA-256, branch and commit are provided in the delivery note; private logs/tokens are not included.
