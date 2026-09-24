# Prospective continuity

Status: **PRODUCTION ARCHITECTURE DECISION** for types and ownership; **PLANNED ENGINEERING** after v0.1.3. These objects are not implemented by renaming existing reminders or conversation text.

Continuity includes what remains to be done, not just what can be recalled. Runtime owns prospective admission, transitions and scheduling. The journal records the evidence; Memory retrieves it; Character expresses its authorized projection. No independent Life Layer owns a second agenda.

| Type | Meaning | Admission / authority | End and decay |
| --- | --- | --- | --- |
| COMMITMENT | YUVI owes a specified Person/audience an action or result | Explicit authorized acceptance, grounded terms, feasible scope and closure condition; generated “I promise” is a proposal until Runtime admission | Fulfilled only by qualifying evidence; canceled/renegotiated/failed/expired/unknown are distinct |
| EXPECTATION | An event, another person's response or a schedule is expected | Attributed source, time window, uncertainty and review condition | Observation resolves or revises it; a missed expectation does not prove another person's motive |
| INTENTION | A private tentative course of action | Low authority, bounded scope/budget, TTL and permission constraints; no obligation imposed on others | Expires unless explicitly renewed; cannot acquire commitment authority through repetition |
| OPEN_THREAD | A derived view of incomplete conversation/work | Projection over receipts and typed items | Decays and is recomputed; no independent durable writer or first-class immortal backlog |

A typed record contains ID/type, causal admission event, responsible party, beneficiary/subject, visibility/audience policy, binding versions, terms/payload reference, creation and due/review windows with clock source, closure predicate, qualifying evidence selectors, status/revision, TTL/decay policy and closing event references. Unknown or missing terms prevent admission as a commitment; a clarifying response can remain ordinary conversation. Do not silently accept obligations to unavailable or unauthorized recipients.

Runtime admits a commitment only after policy/feasibility validation; the resulting user-visible acceptance is causally linked. If the acceptance message fails or is unknown, record that communication uncertainty separately from the accepted obligation. Work completion and notification delivery are separate predicates. “I sent it” from generated text is not fulfillment evidence. External effects use the journal's intent/attempt/outcome protocol.

Transitions append events and use one typed reducer: proposed -> active -> fulfilled/canceled/failed/expired, with unresolved outcome represented explicitly. Reopening requires new authorized evidence and a new revision; a stale model completion cannot reopen a closed obligation. An EXPECTATION may be missed without an external-effect failure. An INTENTION needs explicit re-admission before it becomes a COMMITMENT.

Restart reconstructs due work from durable items, re-evaluates current permissions, membership and deadlines, and never resumes old A2 executions. Offline time can create an overdue review; it cannot silently authorize a burst of old outbound messages. Deduplicate scheduling by item/revision/trigger identity. Handle clock changes, user absence, cancellation races and unknown send outcomes through the same Runtime path.

Visibility is enforced at admission, retrieval and disclosure. A private commitment must not leak via a group open-thread projection. The evaluation baseline `B0p+L2` adds these explicit prospective items without a learned disposition. It isolates how much apparent continuity was simply absent obligation machinery. See [experiments](research-methodology.md) and atoms P1–P3 in the [roadmap](post-v0.1.3-roadmap.md).
