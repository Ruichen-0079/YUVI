# Independent Characters on one YUVI harness

YUVI Core binds each Runtime composition to one persistent Character. A
Character definition is authored Identity/Persona data; an instance ID owns
experiences. Neither a surface, a process PID, a model nor the legacy `personaId`
selector is that continuous identity. The default binding remains native Yuvi.

`CharacterBinding` is immutable configuration. The existing Runtime, Memory,
Cognition, Journal, A9 and provider implementations remain the execution graph;
there is no CharacterInstance manager or second Memory implementation. Multiple
surfaces of the same Character attach to that graph. Alice production/testing
use the same definition and different instance IDs/storage. Yuvi and Alice use
different definitions and different instance IDs/storage.

## Ownership

| Resource                                                                                        | Ownership / sharing                                                                                                         |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Authored Identity/Persona, P8 reconstruction/corrections                                        | Character instance; definition revisions may change without changing experience owner                                       |
| Memory, relationship evidence/interpretation, Profile                                           | Character instance × subject; never a shared Memory layer                                                                   |
| Recent conversations, sessions, episodes, Dream/Finalized work                                  | Private composition repository view; equal session IDs in different Characters remain independent                           |
| Proactive suppression, consent projection, scheduler, execution/cancellation, context manifests | Private Runtime/host graph and durable state                                                                                |
| Provider Registry, route observations, accounting adapter                                       | Separate mutable coordination objects per composition                                                                       |
| Product Person                                                                                  | Explicit shared read authority to the existing canonical Product store; only ID/display name/revision are projected         |
| Trusted voice binding                                                                           | Optional host-granted canonical binding reader plus explicit binding realm; Memory uses the consuming Character's own scope |
| Model HTTP serving, remote providers, PostgreSQL daemon                                         | Shareable infrastructure; private clients/accounting/repository views                                                       |
| World Person/binding mutation                                                                   | Existing canonical host authority; Character workers do not become additional writers                                       |

Even facts about the same Person remain separate Memory records. Future
cross-Character information transfer must create a receiving observation and
pass ordinary admission. Person notes and old Person `personaId` are not shared
as another Character's Profile or relationship.

## Storage boundaries

New instances use the existing user × character scope encoding, with reserved
character dimension `character-instance:<instanceId>`. Runtime stamps it;
MemoryService and provider/Profile access views reject foreign scopes. Backend
results are checked too. The primary legacy path rejects the reserved instance
namespace, while retaining historical persona aliases exactly.

A composition has private configuration/data roots and a private logical
PostgreSQL database or schema view. This is deliberately stronger than changing
Journal namespace: conversation restoration and A9/Finalized/Profile recovery
scan their existing tables. Migration 025 records the owner; a checked-out
PostgreSQL advisory lock permits one active host writer per view. File manifests
reject accidental root reuse. Ownership is claimed before bootstrap/recovery.
An owner mismatch fails startup, including after a restart. New Characters
cannot adopt unowned historical state. These are trusted-host isolation
boundaries, not a hostile multi-tenant database ACL system.

Default single-Character deployments need no new configuration. Existing Memory,
voice bindings, corrections and proactive bytes/scopes remain in place. The
primary can adopt its old stores; no destructive rewrite or re-embedding occurs.
Explicitly binding an existing primary to the _new instance scope_ is not an
automatic migration: continue using the omitted-binding legacy primary until a
separate intentional scope migration exists.

## Composition and deployment

Embedders call `characterComposition(...)`, then
`buildServer(config, { characterComposition: composition })` or the existing
`createAppContext` with that composition. Do not share its Memory repository,
conversation repository, event bus, Registry, workers or state stores with a
different Character; Core rejects shared mutable coordination objects.

The initial physical deployment is one worker process per composition. Its
bootstrap entry also accepts `YUVI_CHARACTER_CONFIG_PATH` pointing to a JSON file
outside the private state directory:

```json
{
  "version": 1,
  "instanceId": "alice.production",
  "definition": {
    "id": "alice",
    "revision": "1",
    "name": "Alice",
    "persona": "Alice's complete authored persona goes here."
  },
  "envDirectory": "/absolute/path/alice-production",
  "peopleDirectory": "/absolute/path/canonical-world-owner",
  "subjectUserId": "person:chen"
}
```

Omit `peopleDirectory` when no canonical Person read authority is granted. The
configuration contains no provider secrets. The existing environment and that
composition's `.env`/`.env.local` configure endpoints, database URL and port.
Apply all Memory migrations to its empty private database/view before startup.
For schemas, use a PostgreSQL URL `options` parameter selecting the private
schema first; all harness tables, including `character_runtime_owner`, must be
created there. A database per Character is the simpler operational choice.
Do not point a new Character at the primary's database or data root.

Launch the same built server entry twice with different config paths, ports and
private database views. Point both `LOCAL_MODEL_BASEURL` (or existing product
routes) at **one** model server. There is no automatic second model-stack launch.
Serving queue/slot policy belongs to the shared inference service. Character
workers omit global Product/People/service-control/settings routes; the existing
primary host retains those authorities. P8 remains available through the
host-owned protected command port. This change does not introduce a desktop
roster UI or a process supervisor that launches/manages every Character.

In-process separate graphs are supported for trusted embedders. Process workers
remain preferred for production isolation, since desktop control/presentation
helpers still include process-level integration. Do not reuse a host's physical
presentation sink across independent Characters without an explicit target
binding. `DIRECTED_TO_YUVI` remains a legacy ABI enum spelling for a directed
turn; the bound definition owns Identity/Persona. Ambient group addressing is a
separate future consumer task.

Plunge should bind its QQ transport to the Alice composition, with QQ speaker,
mention/reply/thread context and trusted principal→Person resolution. It should
not replace Yuvi's prompt or invent Memory/P8/relationship/lifecycle namespaces.
Generic authored persona replacement belongs to Character definition.

## Evidence and limits

Automated acceptance covers shared canonical Product Person without private
notes, grounded Memory A/B with equal subject/session IDs, rejected cross-scope
reads, durable conversation/P8/relationship/suppression ownership, independent
Registry accounting, concurrent executions/cancellation, private storage reuse
rejection, same-Persona test/prod namespaces and two actual worker processes with
restart. Unit tests also reject foreign backend events/Profile sources and
preserve primary legacy aliases. An opt-in provider test calls one actual local
model process through two Registries.

Run `pnpm check`, `pnpm build`, and `pnpm test`. PostgreSQL acceptance enables with
`YUVI_MULTI_CHARACTER_TEST_DATABASE_URL` or existing
`YUVI_JOURNAL_TEST_DATABASE_URL`; it creates/drops only unique test schemas.
Build first: the worker test intentionally runs the real built bootstrap entry.
`YUVI_MULTI_CHARACTER_MODEL_BASE_URL` enables the actual-model experiment.
The release conformance owner inventory includes these boundaries. Full Linux
packaged conformance still requires its existing native PG16 distribution,
Mem0 packaging Python and pinned Node prerequisites; ordinary PostgreSQL tests
are not a substitute for that gate.

A supervisor roster, desktop Character selector, external-principal binding
administration, per-Character physical TTS/presentation targets, full shared
voice-reader bootstrap configuration and production Mem0 sidecar multi-instance
load testing are deferred. Voice identity read injection is available to trusted
embedders; the JSON bootstrap does not grant or recreate a world binding writer.
No real QQ account is used by this implementation or its tests.
