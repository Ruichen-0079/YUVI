# Local attention and group Character input, 2026-10-08

The subsequent user-requested linear input projection and current attachment
availability changes are documented in
[Character linear context validation](character-linear-context-2026-10-08.md).
The generation and acceptance status below describe this integration checkpoint.

The bounded Qwen3.5-4B gateway is connected to Alice's real QQ group admission
path. The model selects review or observation only; the main Character retains
RESPOND/SILENCE authority. Its selected artifact, CUDA runner, MTP comparison
and fixed generation limits are documented in
[the deployment checkpoint](local-attention-qwen35-4b-2026-10-07.md).

## Scope and worktree

The original visual-context fixes remain committed at `45db2c7`, live image
acceptance at `c8602ba`, and local model provisioning at `6ceeaa7`. Integration
started from those commits and preserved the uncommitted integration changes.
No reset, checkout, Persona replacement or native transport rewrite occurred.

The opt-in Plunge `attention` configuration identifies the loopback bounded
`/attention` gateway and an absolute private key-file path. No credentials or
private QQ captures are committed. Without the option, existing admission is
unchanged. Embedding services on 8128 and 11434 are unchanged.

## Admission and input boundary

Private messages, native mentions and observed replies to Alice bypass the
optional prefilter. SELF events and duplicates cannot be promoted. Ambient
group events and heuristic continuation candidates are classified using the
whole current event and only whole older observations fitting 6000 characters.
Oversized current input is handed to Character without truncation. IGNORE
still produces a durable observed receipt and retains ambient image handles;
it produces no Character request or native send. ATTEND, UNCERTAIN, timeout,
malformed response and service failure admit review as `ATTENTION`, preserving
actual mentions and reply facts. A generation replaced during classification
cannot admit or repopulate the new scene.

The first live integration exposed two semantic failures:

- Treating a recent same-speaker continuation as unconditional admission let
  testing discussion bypass the local classifier.
- An admitted group participant's text entered a user-role Chat request with
  the server adapter's direct-chat assumptions. Group addressing appeared in
  quoted scene data, while historical assistant invitations could make
  subsequent ambient discussion look like a pending request.

`qq-attention.v3` treats continuation as a candidate, distinguishes talking
about Alice from talking to Alice, and does not admit an independent image
merely because earlier Alice speech exists. It confirms earlier participation
only from acknowledged SELF expression, rather than an ADMITTED_TURN marker.

Runtime now passes validated surface/conversation/admission facts separately
from scene prose through both initial Character and cognition re-entry.
The server adapter projects a short group input instruction above semantic
data: user-role transport does not itself establish engagement; name calls,
greetings and questions can invite a response without a native mention;
ambient third-person/testing discussion and no-reply requests can warrant
SILENCE. Admission is review, not a demand to speak. The projection is versioned
`character-group-input-boundary.v1`. Private/direct inputs retain their existing
instruction. Authored identity and Persona remain intact.

All gate, retry and final response requests include the boundary in rendered
budget measurements. Adding a verbose instruction initially caused the new
populated-group regression to exceed the 10240-character working limit.
The fixed transport instruction was shortened; the complete current scene,
4000-character perception and regression assertions were preserved. Optional
history remains the compression/omission target. The original populated-private
regression remains and now has a group counterpart.

## Actual provider evidence

Private evidence directory:
`/home/ruichen/.local/share/yuvi/local-4b-20261007/`.
Actual QQ captures and model responses:
`/home/ruichen/.local/share/yuvi/plunge-alice-20261007/`.
The loopback capture proxy records actual outgoing Chat requests, including
final streaming requests, rather than only Runtime evidence objects.

The first no-mention `Alice 你在吗` event (`834894878`) returned ATTEND with two
completion tokens in 109 ms. Actual gate `rendered-chat-034.json` and final
streaming request `035` both contained that current input, current speaker,
`ATTENTION`, and an empty mentions array. The reply was acknowledged by QQ;
the durable outbound receipt recorded ACKNOWLEDGED and
EXTERNAL_SERVICE_ACCEPTED. A true mention (`632297108`) bypassed the classifier
and produced gate/final captures `036`/`037` and a native ACK.

An initial over-admitted group image was genuinely analyzed: actual Vision
returned a two-panel meme observation; final streaming capture `039` contained
its full normalized observation and the current image turn, then QQ acknowledged
the response. This proves the perception-to-final-request chain, but was an
attention false positive for an independent image; it is not counted as desired
admission behavior. v3 subsequently observed independent images without replies.
The earlier fresh private-image and group-image acceptance remains documented in
[the original Alice live validation](plunge-alice-2026-10-07.md).

`main-gate-boundary-final-replay.json` reconstructs seven actual gate contexts
through the production Character adapter and actual configured Chat provider.
It retains the original image-resource descriptions, current scene, identity,
Persona and optional history subject to the production budget. No QQ sends or
live conversation writes occur in this diagnostic replay.

| Original capture | Current input         | Actual final gate |
| ---------------- | --------------------- | ----------------- |
| 042              | 测试看看她能不能区分  | SILENCE           |
| 044              | 得对比一下            | SILENCE           |
| 047              | ok 问题很大           | SILENCE           |
| 034              | Alice 你在吗          | RESPOND           |
| 036              | 在吗 (real mention)   | RESPOND           |
| 073              | ciallo (real mention) | RESPOND           |
| 076              | 你人呢 (real mention) | RESPOND           |

Each replay made one real provider call; rendered inputs were 8944–10102
characters. Earlier incomplete-resource and verbose/compact instruction replay
results are retained separately, including false replies and false silences;
only the final production instruction results above are counted. The seven
samples do not establish general recall or eliminate all model judgement errors.

Real integrated classifications took about 93–550 ms for contexts up to about
6000 characters, always two completion tokens in inspected successful calls.
The standalone short benchmark's roughly 55 ms median does not describe a
history-rich QQ context. Generation remains temperature zero, thinking disabled,
maximum four output tokens, grammar constrained to A/I/U. MTP remains off
because it was slower for this short decision workload.

## Verification

- QQ attention/social/Character targeted tests: 59 passed, including populated
  private and group scenes with existing history and complete perception.
- Core suite: 480 passed, 2 skipped.
- Server suite: 535 passed, 220 skipped (environment-dependent integrations).
- Explicit isolated PostgreSQL QQ Core and outward transport suites: 24 passed,
  no skips; IGNORE receipt, actual gate/final input boundary and native ACK
  publication are covered.
- Gateway Node tests: 5 passed.
- `pnpm check`, `pnpm build` and `git diff --check`: passed.

Enabled user services: `yuvi-local-attention-model.service`,
`yuvi-local-attention.service`, `yuvi-alice-context-capture.service`,
`yuvi-plunge-alice.service`. Alice is not dependent on classifier availability:
backend failure falls back to main Character review. The capture proxy was
restored as a persistent service after the old manual capture process disappeared.
It uses the existing upstream configuration and does not rewrite provider keys.

Final deployed generation: `f8021ad1-4593-4f52-b7c8-48f47177601b`.
Old in-memory image handles are invalid after restart; new image acceptance
requires freshly delivered media. Final post-deployment live tests are pending. The user asked to inspect the raw
Chat input before sending another round; no new-generation result is inferred
from prior-generation captures or diagnostic replay.

## Raw input inspection requested by the user

Actual capture `047` (old gate, `ok 问题很大`) contains a 9322-character
system message, a 7-character current user message, and a 548-character user
context describing available image resources. It uses temperature 0.7 and
2048 maximum output tokens. The final response request `048` retains the same
current message, scene and history, with the gate instruction replaced by a
RESPOND-authorized body instruction; its system text is 7355 characters.

The old system prefix asks Character to fulfill an unresolved request if the
current turn continues it. Its semantic JSON includes ordinary `User:` and
`Assistant:` history labels. Those labels omit the historical participants'
identities, while the current speaker and native addressing are buried in
CURRENT_SITUATION prose. History includes past assistant claims that it could
not see images and invitations to describe/compare them. Retrieved Memory also
repeats an older image question as unresolved. These are concrete input-layout
and authority ambiguities; the observations do not justify attributing failure
to the Chat model's intelligence.

The new top-level group instruction removes the direct-chat continuation
assumption and states that admission and prior questions do not make ambient
talk a current request. Capture `105` is its actual provider replay for this
same current text, with original resource descriptions preserved, yielding
SILENCE. It is a replay, not a new live QQ turn. The underlying recent-history
representation still uses flattened User/Assistant labels; restoring full
historical speaker metadata is not claimed by this bounded integration.

Private exports containing the complete decoded message strings, without
content truncation:

- `raw-chat-047-decoded.txt`: old gate.
- `raw-chat-048-decoded.txt`: old final streaming request.
- `raw-chat-105-decoded.txt`: corrected real-provider gate replay.
- `raw-chat-039-decoded.txt`: actual image-containing final streaming request.
- Corresponding `raw-chat-*-semantic-context.json` files pretty-print the
  semantic JSON for inspection; raw wire JSON remains in `rendered-chat-*.json`.

These exports live in the private model audit directory and are not committed.
