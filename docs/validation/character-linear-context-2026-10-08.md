# Character linear model context, 2026-10-08

The model-facing Character context now presents attributed channel messages in
chronological order, followed by the current participant message, current
attachment availability and direct perception. The validated canonical ABI,
source references and semantic authority remain internal. This is a bounded
presentation change, not a Persona, Plunge or Runtime architecture replacement.

## Starting point and retained work

This change starts at `9a99ae7` on `feat/plunge-alice-20261007`. The previous
visual normalization, complete-current-evidence budget policy, actual QQ image
acceptance and local attention integration remain intact (`45db2c7`, `c8602ba`,
`6ceeaa7`, `9a99ae7`). The worktree was clean when this presentation task began;
no reset, checkout, historical message deletion or configuration replacement
was performed.

Inspection of actual outgoing capture `047` showed about 9,900 UTF-16 characters
spread across semantic JSON, flat User/Assistant history and a separate image
resource user message. Historical assistant capability claims and duplicated
unresolved image questions could compete with a short ambient group remark.
The canonical object also exposed versions and provenance identifiers that
were useful to audits but added no conversational meaning to the model.

## Presentation and message types

`character-linear-context.v1` uses two transport messages:

1. **System:** control choices, authored identity/Persona, relationship context,
   recalled historical claims, applicable normalized Cognition result, and one
   local clock. Empty optional headings, canonical JSON envelopes, source-reference
   arrays and the redundant temporal episode index are omitted.
2. **User:** native scene and chronological observations; current speaker,
   actual mentions and quoted reply; exact current participant text; current
   attachment sources when needed; full direct perception from that same turn.

The user role represents transport. It does not make every quoted channel
message a directed request. The existing group boundary still leaves SILENCE
available to the main Character. Admission flags are internal review metadata,
not model-facing evidence that somebody demanded a reply.

Native observations distinguish `[TEXT]`, `[IMAGE]`,
`[SELF_SENT: ACKNOWLEDGED]`, `[SELF_DRAFT: publication UNKNOWN]`,
`[SELF_OBSERVED]` and `[QUOTE: OBSERVED/UNRESOLVED/CONFLICTING]`. Display names
include stable compact actor references, so equal names do not collapse actors.
An acknowledged Alice expression is visible as her speech; an unpublished
draft does not establish that the channel heard it. These display references
cannot establish binding or authorization.

Visual descriptions are labeled `[PERCEPTION: image observation, not participant
speech]`. They are appended to the existing current message, not inserted as a
new user turn. Normalization still removes exact `text`/`sceneSummary` aliases,
retains distinct descriptions and uncertainty, and projects source namespace
and event once as readable provenance. Cognition retains its normalized
status, answer, caveats and uncertainty under an analysis/tool-result label;
its ABI version is not response evidence.

Native messages replace the ambiguous flat Recent Conversation projection.
Direct non-native conversations retain their ordinary recent history.
Retrieved episodes project controlled task/unresolved fields once as historical
state; generated assistant prose is excluded from the factual Memory projection.
Stored episodes and durable conversations are not modified. This bounded native
view uses the available recent channel observations; it does not claim to recover
missing historical speaker identities from old User/Assistant strings.

## Budget, availability and audit

The actual rendered text and conservative role reserve determine model
admission. Opaque canonical metadata no longer consumes model context budget.
Complete current text, scene/addressing, current quoted reply, direct perception,
authored required semantics and normalized Cognition remain protected. Optional
history is compressed or omitted first, including whole-section omission when
the generic compressor's 160-character floor cannot fit. Required information
that cannot fit alone still causes an explicit failure; it is never silently cut.

Older native observations may be excerpted at 512 characters or omitted to fit
the bounded scene. The complete current quote is reprojected from validated
typed facts, including when the legacy canonical scene cap cut its tail.

Historical image delivery and **current retrieval availability** are separate
facts. Before perception, a short Runtime-owned attachment inventory remains
visible even when a handle appeared in history or participant text. After
perception, redundant source display is removed only when matching typed facts
are actually present in the rendered scene. Participant text cannot suppress
the inventory. No image content is inferred from a source handle.

Real provider replay exposed incorrect control choices when perception was
described after the allowed-disposition list. The available visual request shape
now sits in the same gate choice list, before background data. RESPOND means
ready to answer, rather than a promise to inspect later. Presentation/proactive
examples explicitly describe fields within a disposition object, not standalone
responses. This retains Character's choice; no QQ-specific perception heuristic
or forced response was introduced.

Provider exposure accounting consumes producer-declared spans validated against
the actual message index, offset and length. It records exposed/transformed/
truncated/omitted blocks with canonical source references. The spans and version
tags are backend audit metadata; concrete transports do not send them to the
model. Invalid spans and participant-provided text cannot claim canonical
provenance. This replaces reliance on finding the old JSON envelope in system
text, which would incorrectly report the new layout as omitted.

## Actual requests and verification

Private diagnostic files are under
`/home/ruichen/.local/share/yuvi/local-4b-20261007/`; original outgoing wire captures
are under `/home/ruichen/.local/share/yuvi/plunge-alice-20261007/`.
They are not committed. The capture proxy forwards and records the actual HTTP
Chat payload, including final streaming requests.

Archived private question `029` and group question `032` were replayed through
the production Character adapter and configured DeepSeek provider with their
full original Vision observations. Actual final wire captures `123` and `131`
contain two roles, the exact question and complete observation in the same user
message; both produced image descriptions. Readable copies are
`linear-final-private-image-decoded.txt` and
`linear-final-group-image-decoded.txt`. This demonstrates final-input exposure,
not a new QQ delivery or ACK.

Complete Core/native replays then read the archived private and group image bytes
again using fresh isolated resource generations and the real Vision provider.
Final private capture `181` and group capture `164` are actual streaming requests.
Both contain the exact current question, current speaker/addressing and the
complete corresponding successful Vision response text exactly once. Their
readable files replace the earlier adapter-only copies above. The source events
identify isolated replay namespaces, not restored live image handles.
`linear-current-chain-evidence.json` records the request/observation equality
checks and successful Vision timestamps. Both streams produced image descriptions;
fixture publication deliberately threw, so there was no native send or ACK.

The ambient `ok 问题很大` sample dropped from 9,885 to 4,642 UTF-16
characters, with canonical provenance still available to audits. The diagnostic
preserves old Memory claims deliberately as an adversarial case; fresh production
Memory also receives the historical-state and assistant-prose changes above.
Earlier linear runs silenced all three testing remarks, but the final control
layout's replay is mixed and is not reported as a passed attention suite:

| Original capture | Current input                                        | Final-layout provider outcome                          |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| 042              | 测试看看她能不能区分                                 | visualNeed; intercepted by the archived-evidence probe |
| 044              | 得对比一下                                           | visualNeed; intercepted by the archived-evidence probe |
| 047              | ok 问题很大                                          | SILENCE                                                |
| 034              | Alice 你在吗                                         | RESPOND                                                |
| 036              | 在吗 (true mention)                                  | RESPOND                                                |
| 073              | ciallo (true mention)                                | RESPOND                                                |
| 076              | 你人呢 (true mention)                                | RESPOND                                                |
| 039              | Independent image, with archived perception supplied | RESPOND, unwanted insertion                            |

`linear-provider-replay-final-v3.json` and its log retain these outcomes. Real
ambient events still traverse the independent local attention prefilter first;
these direct Character probes bypass it. The representation is clearer and the
current evidence reaches final requests, but unwanted main-Character perception
or insertion in ambiguous historical contexts remains a judgement limitation.

Replay is not a guarantee of judgement quality: a later run silenced the unusual
mentioned greeting `ciallo`, and early complete-Core group runs selected
Cognition instead of perception, returned malformed control output, or promised
to view an image without requesting it. These failed attempts remain in the
`linear-core-native-replay*` and `linear-provider-replay*` logs. One upstream
stream also returned a malformed SSE frame; its failure and retry are retained.
Successful archived-observation replay is not counted as fresh Vision execution.

Verification:

- Core visual evidence, runtime visual grounding and surface tests: 27 passed;
  full Core suite: 480 passed, 2 environment-dependent skips.
- Full server suite: 538 passed, 220 environment-dependent skips; includes rich
  private/group scenes, complete perception, complete Cognition and current quotes.
- Explicit isolated PostgreSQL QQ Core, outward transport and production
  Character paths: 34 passed, no skips, including actual rendered exposure and ACK
  publication accounting.
- Providers: 388 passed, 1 skip; Memory: 501 passed, 58 environment-dependent skips.
- `pnpm check`, `pnpm build` and `git diff --check`: passed.

Post-deployment private/group acceptance and native QQ ACK must use newly
delivered messages and images. Diagnostic native replays intentionally block
all QQ writes and use isolated temporary database schemas; their publication
attempts remain UNKNOWN, never ACKNOWLEDGED. Prior-generation live image/ACK
evidence is in [the original Alice validation](plunge-alice-2026-10-07.md).

Alice was rebuilt and restarted with this change. Active services are the local
model, bounded attention gateway, capture proxy and Alice. New live generation:
`8a2e4b27-59a9-4b2a-91f9-9c0b3d81ade3`; `/health` is READY with healthy server and
database. Old live image handles are invalid. Fresh private image/question,
group no-reply/genuine-question and native ACK acceptance have been requested
and remain pending; archived replay does not satisfy that live checkpoint.
