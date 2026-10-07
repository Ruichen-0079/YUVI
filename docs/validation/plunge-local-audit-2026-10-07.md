# Plunge local history audit — 2026-10-07

Authoritative repository: `Ruichen-0079/YUVI`; branch: `main`.
Local audit evidence: `/home/ruichen/yuvi-plunge-audit-20261007` (contains no copied account credentials).

## Initial state and preservation

`/home/ruichen/Projects/YUVI` started clean on `main` at
`020f09fdfc0f284bd0e5be665a187f4274f01581`. Before fresh-fetch it appeared five
commits behind its cached remote. Fresh-fetch of main and tags found
`46a24878536d537021c49d50c5ce004d93489628`, actually 74 commits ahead.
A separate explicit fetch of `research/qq-alice-20261007` completed successfully.
No reset, forced checkout, stash pop, reflog expiry or garbage collection was performed.
`backup/pre-plunge-main-20261007` preserves the initial main. Main was fast-forwarded,
then `feat/plunge-alice-20261007` was created from that fresh baseline.

All ten registered worktrees were inspected. The old platform worktree
`YUVI-v0.1.3-platform-20260922` is on `codex/v0.1.3-platform-completion-20260922`,
HEAD `e8a0971929870df8f6b63ed7de4308e4fae4aff3`, 25 commits ahead of its cached
upstream. It contains an edited frontend handoff and untracked pre-entropy
research. Both were classified as unrelated user documentation and preserved in
`old-worktree.patch`, `old-staged.patch` and `old-untracked.tar.gz`; originals remain.
Other dirty release/old desktop/Atom worktrees were recorded and left untouched.
The separate lowercase `Projects/yuvi` clone points to `Ruichen-0079/UV-main`,
not the authoritative remote; it and its many worktrees/stashes were read only.

The YUVI common Git store has two stashes. Their file inventories and full
reflogs were recorded. `git fsck --full --no-reflogs --unreachable` found 22
unreachable commit roots, including an older QQ conformance revision
`f62176d899c9576c21d7bab99ad08d3225a73560`; metadata was read and their reachable
objects were copied to `unreachable-history.pack`. No evidence relies solely on
an abbreviated earlier summary.

`dbb4b984a2d3354cb96d32943e9fed30035bcaf1` **exists as a readable commit**, is
reachable from the old platform branch, and appears in reflogs. Its change avoids
unchanged QQBot migration DDL during live canonical turns. The old QQ source,
QQBot repository/context, host, plugin tests and source/live contract records are
available on that worktree. They are history, not the new architecture authority.

## Research archive verification

Tag dereferences to the required commit
`3dc91f35a0b5037d411a79d4b89e9b7762a09cd1`.
Each file was exported with `git show`, counted and independently SHA-256 checked.

| Original                                     |  Bytes | SHA-256                                                          |
| -------------------------------------------- | -----: | ---------------------------------------------------------------- |
| QQ-Alice-research-2026-10-07.md              |  50452 | d85385a4a758bfc1e3803736cfe5a608b3c18a413bdd3345b4e4007355f1f7e7 |
| QQ-research-evidence-2026-10-07.zip          | 301751 | 0e8922e969609367e1478e11232653162f918f69719212c6882bba04a3b33e18 |
| YUVI-Multi-Character-research-2026-10-07.md  |  64239 | 82552bd8392bd25fe6dc8b84900e43b142f4541032a38be39899913df7ee6dae |
| YUVI-Multi-Character-evidence-2026-10-07.zip | 185049 | 91a36ce4cc03608b1e09cf6baade051de09d3c564013155184fec1ca902997b9 |

Both evidence ZIPs pass CRC verification. The nested `qq-snowluma.zip` is 138805
bytes, SHA-256 `aec0eb58d8bc6f3612e101da23453972532b1de6f60111438269320ac927c570`.
It was actually extracted: `manifest.json`, readable `index.js` (137045 bytes)
and `assets/THIRD_PARTY_NOTICES.txt`; JavaScript syntax validation passed.

A separate recursive local search (including hidden application data and the
mounted data workspace) found 19 readable copies of the QQ plugin, **five distinct
variants**, including 133828, 135468, 135549, 138777 and 138805 byte archives.
Their CRCs, manifests and index.js hashes were checked and unique versions
extracted under `local-variants`. Early copies live in `~/.local/share/yuvi-a11-data-*`.
The platform worktree, downloaded release copy and archived research copy match.
The search also found the pinned SnowLuma source, installed runtime, account
configuration and historical live evidence. Secrets were neither printed nor
copied to audit files.

## Historical migration classification

| Classification | Historical responsibility                                                                                                                                                     | New destination                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KEEP           | SnowLuma/OneBot framing, authenticated account readiness, signed local message handles, finite transport queues, native ACK uncertainty constraints                           | Plunge transport/codec; update and test connection generation fencing                                                                                         |
| MOVE TO CORE   | Character definition, Memory, Relationship, Profile, P8 reconstruction/corrections, conversation restoration, cognition and proactive/execution lifecycle                     | Existing independent Character composition and existing Runtime/Memory/Journal/A9; no new personality or cognition engine                                     |
| REWRITE        | QQ sender identity, local Person construction, group context, admission, target publication, media and quote handling                                                         | Host-granted canonical Product Person lookup; bounded speaker-labelled observations; admitted turns; generic Character surface port and canonical publication |
| DELETE         | PERSONA replacement, prompt-only claim of own social memory, QQBot parallel memory/group/profile authority, plugin cognition/personality loop, every-group-message user turns | Absent from new implementation; historical branches and original archives remain preserved                                                                    |

The current main does not include the old QQBot/plugin stack. This is a thin new
consumer of the consolidated Core, not a cherry-pick of that obsolete stack.
No local 4B router will be introduced before real baseline traces justify it.
