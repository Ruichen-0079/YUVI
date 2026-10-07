# Plunge and the independent Alice Character

Plunge knows QQ. Alice knows Alice. Core owns a Character's life.

Alice is an immutable `CharacterComposition`, created by the existing bootstrap
using `YUVI_CHARACTER_CONFIG_PATH`. The simple initial authored persona is kept
in that composition, never in a transport prompt replacement. Alice and Yuvi
may use the same Product Person reader, model services and database server.
Their Character identities, owned filesystem roots, PostgreSQL schemas, Memory,
Relationship, Profile/Perspective, recent conversations, corrections, proactive
policy, P8 and execution state remain separate. The existing composition claims
reject overlapping mutable roots/schemas. Restarting Alice does not restart Yuvi.

`YUVI_PLUNGE_CONFIG_PATH` selects private host configuration: the existing
SnowLuma OneBot configuration path, expected logged-in account, deployment,
allowed group/private targets, explicit sender-to-Product-Person grants and media
roots. Tokens are read from existing private configuration, never committed or
included in model-visible context. This configuration is an operational grant,
not a second identity, personality or Memory system.

## Generic Host boundary

`HostCharacterSurfaces.bind(grant)` gives a plugin a narrow receive port. The
Host, not wire data, resolves canonical Product Person bindings and owns Journal
receipt admission, Character dispatch, media resource ownership and canonical
publication. The plugin receives no model, Memory, Relationship, P8 or persona
replacement interface. `surfacePlugins` uses the existing PluginLifecycle.

Generic normalized social context describes PRIVATE, GROUP and TEMPORARY_PRIVATE
scenes, scoped principals, observed nicknames versus canonical Person names,
mentions, replies/quotes, the Character's own identity, source Journal references,
prior observations and media availability. Runtime receives this schema and
provider-neutral visual sources. No QQ-specific field belongs to RuntimeOrchestrator.
These contracts can also describe Discord, Telegram or Matrix surfaces.

Unknown senders get a surface-scoped principal and no Memory read/write authority;
they never inherit the environment's default Person. Group audiences remain
unknown rather than claiming that all participants are authenticated Product People.
Observed nicknames do not change canonical identity. QQ numbers are normalized
without unsafe numeric conversion; signed message handles are distinct from UINs.
Temporary-private origin is separate from the private recipient used for sending.

## Observation and an admitted turn

The QQ codec normalizes native segment relationships. Ordinary group input is a
durable receipt and a bounded scene observation, without a Character/user turn.
Private input, a real mention of the current account, a recently observed reply
to that account, or a bounded direct continuation can enter the existing Character
gate. Admission never mandates a reply. Core still chooses RESPOND, SILENCE,
NEED_COGNITION or another existing disposition. No local 4B router is installed.

Transport scene state is bounded: 64 channels, 120 seconds, 12 observations per
channel, 128 reply handles and 256 short-lived duplicate fingerprints. Message ID
alone is not durable duplicate identity. Conflicting handles stay conflicting.
Reconnect clears continuation and observed reply authorization. Self events never
become new turns. Native send ACKs also project Alice's own previous expression
into the scene, even when SnowLuma self-event reporting is disabled. Generated
text with UNKNOWN publication is projected as unconfirmed; it is not evidence
that other participants heard it. Recent assistant generation history is
distinguished from acknowledged speech.

## The model-visible conversation world

`renderSurfaceSituation` projects generic facts into a readable scene: where the
conversation is happening, who is speaking, whom they mention/reply to, which
previous expressions are SELF, and which events are AMBIENT versus ADMITTED_TURN.
Chronological observations remain evidence, not additional current user requests.
Budgets retain current relations and the newest whole events. Omitted older events
are explicitly PARTIAL. Canonical context reserves room for the current scene
instead of blindly keeping the beginning of an old 4,000-character situation.
Repeated long principal namespaces use consistent compact display handles in
the scene and source descriptions, while original authority identities remain
unchanged. Authored identity/persona and the stable semantic prefix are preserved.

Receiving an image event is different from knowing its contents. The Host owns a
bounded, scoped resource keyed by its original Journal event. An ambient image
is not read or analyzed and does not become a user turn. A later admitted turn
receives descriptions of readable sources, including author, time and exact
reference. Character can select a source through the existing single visual
cycle. It must select an explicit reference; Core does not infer a last image,
a nearest image, a same-speaker cache or a desktop capture. Ambiguous references
can lead to a clarification. Expired/stale resources are visibly unavailable.
A current attached image uses the existing attachment/Vision path.

Selected visual observations and source provenance are preserved across gate
re-entry, Cognition if requested, and the final streamed ChatModel request.
Source descriptions are separate untrusted observation messages, retained in
both gate and response requests. Once a visual cycle finishes, only the selected
source inventory remains actionable; other image events stay scene observations.
Late-added evidence is included in the same rendered-request budget, preserving
current scene and authored semantics while shortening optional earlier context.
Budget accounting counts actual model-visible text and frame reserves, without
double-counting HTTP JSON escaping. Mixed visual/reasoning output receives at most
one generation repair before any perception executes; completed visual cycles
are never retried. Stronger reasoning is not a substitute for
missing perception. No second cognition loop or permanent visual-memory cache
is introduced. Existing grounded-turn Memory policy is reused.

QQ media fetch is bounded by time/size, realpath allowlisted roots or allowed
QQ HTTPS CDN hosts, and image magic. Unsupported file/audio/video segments and
additional images remain visible with unknown contents; they are not silently
presented as analyzed attachments. The first version analyzes one image per turn.

## Publication and certainty

An admitted inbound event is Journaled before Runtime. A generated reply component
and its target publication are admitted atomically through existing A9. Outbound
flow is Core reply → Host canonical publication → QQ codec → SnowLuma action.
SILENCE creates zero sends. A valid native response is EXTERNAL_SERVICE_ACCEPTED,
not evidence that a recipient received or read it. Ambiguous dispatch is UNKNOWN
and cannot be blindly resent. Post-ACK scene projection failure does not rewrite
an already APPLIED publication as UNKNOWN. Generation fences reject stale reads,
ACKs and writes after reconnect or shutdown.

Generation failure preserves the received observation and its resource so later
conversation does not lose an event that the user actually experienced. It is
reported as FAILED, separately from SILENCE and uncertain publication.

## Historical migration

See [the preserved local audit](../validation/plunge-local-audit-2026-10-07.md).
KEEP protocol knowledge and historical evidence; MOVE TO CORE Character identity,
P8, Memory, Relationship and lifecycle ownership; REWRITE transport normalization,
bounded context and canonical publication; DELETE persona replacement, prompt-only
social memory, duplicate cognition/personality loops and blind send retries.
The historical `qq-snowluma.zip` is evidence, not architectural authority.
