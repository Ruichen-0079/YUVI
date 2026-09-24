# Principals, Persons, audience and claims

Status: **PRODUCTION ARCHITECTURE DECISION**, with **PLANNED ENGINEERING** in A8/A10/A12. Current local-controller and voice boundaries are preserved as described in [implementation baseline](implementation-baseline.md).

A **principal** is an authenticated transport/account/device actor in a namespace. A **Person** is a governed product identity to which one or more principals may be bound. A display name, quoted first-person statement, acoustic similarity or a model's entity guess is neither authentication nor binding authority. Local controller authentication does not transfer to arbitrary QQ senders. An external principal is not automatically the desktop's primary Person.

A binding has an owner, principal namespace, Person reference, valid interval, evidence, issuer/authorization, version and revocation/supersession lineage. The governed identity owner alone commits changes. A principal may remain unresolved, mappings may conflict, and a group may contain several principals. Those are explicit states, not reasons to choose the most plausible person. Account reuse or a corrected voice association invalidates affected descendants by binding version, not by rewriting historical receipt authors.

Current `Person.id/displayName/personaId/notes` lives in controller product settings. Current voice bindings require explicit local-controller evidence and committed STT attribution. P8 surface-form resolution is a linguistic projection, not an account binding. Its `SELF_REPORT`/trusted-explicit language tier must never be reused as transport authentication. A10 adds causal receipts around these owners, without installing a competing identity database.

## Receipt and disclosure audiences

Store receipt-time visibility as a protected snapshot/reference: private recipient, group/channel identity, known membership version or explicit membership uncertainty. Evaluate disclosure again at response time using current membership and policy. Intersection is not sufficient for all content: source restrictions and subject-specific permissions also apply. A group question cannot retrieve a private conversation merely because the same Person participates in both.

A principal binding helps resolve subject scope; it does not merge all scopes or grant historical disclosure. Group memories retain assertor, subject, audience, channel and binding version separately. Joining a group does not authorize old private evidence; leaving a group does not prove deletion at remote recipients. Unknown membership fails closed for protected disclosure while allowing a minimally revealing response where policy permits.

Example: principal B tells a group, “A dislikes hospitals.” The receipt is attributed to B, the claim's subject is A only if resolution is supported, and the claim remains third-party hearsay. B's accurate quotation is not A's self-report. A later private denial by A is a linked counterclaim/correction under authorized scope, not a rewrite that pretends the original receipt never existed. Neither claim permits publishing the other's private source.

## Claim contract

A claim references source event/selectors, assertor, subject, provenance class, resolution state, event/binding/audience versions, extraction method and verification state. Preserve current distinctions including SELF_REPORT, EXTERNAL_CLAIM, DIRECT_OBSERVATION, ASSISTANT_INFERENCE and UNKNOWN_AMBIENT. Unsupported ambient attribution cannot become durable person evidence. Model-generated inferences remain labeled and ineligible for self-disposition consolidation.

Record independent observations as independent only when provenance supports independence. Multiple paraphrases, the same feed mirrored through several accounts, audio plus its transcript, and a reply elicited by YUVI's own leading question are not independent support. A correction can be authoritative about the authorized person's intended preference or account mapping without becoming authoritative about every external fact.

Corrections append AMENDMENT plus owner-specific revision commands. Recompute dependent claims, prospective bindings, projections and selection caches; preserve unrelated nodes and expose any unavailable descendants. Authorizer rights, source fidelity, temporal validity and confidence are separate tests. A10's tests must include impersonation, group/private scope confusion, quoted self-report, renamed/reused accounts, mixed speakers, wrong binding correction and stale membership at send time.
