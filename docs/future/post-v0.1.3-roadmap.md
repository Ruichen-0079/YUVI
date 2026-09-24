# Post-v0.1.3 roadmap: measured research and gated engineering

Status: every atom here is **PLANNED ENGINEERING** or a **RESEARCH HYPOTHESIS** test. None is implemented, and none is v0.1.3 scope. Atoms marked *(gate)* are experiments whose outcome can **stop** later atoms. A stop is a successful result: “explicit, evidence-linked mechanisms are sufficient; no latent self substrate is necessary” closes the latent path.

Experiment definitions (E1–E6) and risks (R1–R8) live in [research methodology](research-methodology.md). Baseline meanings (B0…Z) live in [selection research](selection-research.md). Measurement restrictions live in [measured consolidation](measured-consolidation.md). This file only orders and bounds the work.

## Entry condition

v0.1.3 is closed per [its roadmap](09-v0.1.3-platform-completion.md): durable journal, outbox, lineage-bound consumers (including the A10.1 legacy-extractor repair), context manifests, synthetic conformance and the real QQ probe. No atom below may bypass those invariants, and none may add a writer that the [authority map](authority.md) does not name.

## Dependency order

```text
M1 → M2 → E1a ─────────────────────────────────────────────┐
            ├→ P1 → P2 → P3 (E1 L2 arm) ────────────────────┤
            └→ C1 → E2(gate) → C2 → C3 → C4 (E1 S/B2 arms) → E6
                                   │                          │
                                   ├→ E4, E5                  │
                                   └→ S1 → S2/E3(gate) → PV1 → Z1(gate, optional)
C4 + S1 → RD1 → RD2(gate) → X1
P3 + C4 + E6 → MR1
MR1 + replacement owner gated → PM1 (per field)
E2 → O1 (optional)
```

The explicit order above wins over numeric sorting. Every atom updates its owning document(s) and [implementation baseline](implementation-baseline.md) as part of its own Definition of Done. There is no separate documentation-cleanup atom.

Every *(gate)* atom must commit to version control, **before** running: target behavior, minimum useful effect, failure thresholds, sample size, splitting unit, exclusions, and the decision taken on each outcome. A result without that preregistration cannot promote anything.

---

## M1 — Synthetic life-history generator, accelerated clock and effect-free replay

**Goal.** Replay versioned synthetic life histories through the real Runtime path with an accelerated clock and no real external effects.
**Why it exists.** Every later claim about durable influence needs controlled histories with known ground truth; convincing conversations are not evidence.
**Preconditions.** v0.1.3 closed; A10.3 manifests and A11 synthetic surface available.
**Existing authority to preserve.** Runtime admission, journal append gate, outbox semantics, disclosure checks.
**Exact scope.** Seeded generator families (daily life, gaps, multi-channel, corrections, identity changes, obligations, failures); an injectable clock separating event time from commit time; a replay mode where the outbox binds only to the synthetic surface; a journal namespace per run.
**Explicit non-goals.** No disposition state, no LLM judge, no real-user data, no new production feature.
**Code/docs to inspect.** A11 fixture, journal store, Runtime clock seams, [research methodology](research-methodology.md#measurement-contract-before-state).
**Required invariants.** Replay never dispatches to a real surface. Generator parameters and seeds are stored apart from prompts and judges. A held-out generator family exists before any comparison.
**Failure semantics.** Any attempted real dispatch aborts the run. Clock-dependent nondeterminism is reported, not hidden.
**Required tests.** Same seed produces the same journal (excluding model outputs); a real adapter bound during replay is refused; a years-long accelerated history completes within a declared budget.
**Migration/compatibility.** Test/research-only binaries or flags; production configuration cannot enable replay mode.
**Exit criteria.** Three generator families, one held out, replay through the unchanged Runtime path with a verified zero-real-effect guarantee.
**Downstream.** M2.
**Not yet.** Personality simulators or synthetic “inner life” narratives.

## M2 — Probe suite, blind evaluation and preregistration registry

**Goal.** Fixed behavioral probes, blinded scoring and a versioned registry of preregistered criteria.
**Why it exists.** It counters R3 (ELIZA/judge bias) and prevents post-hoc thresholds.
**Preconditions.** M1.
**Existing authority to preserve.** None is changed. Evaluation reads journals and manifests only.
**Exact scope.** Probe classes: attribution, disclosure, obligation, correction, manipulation, recall, choice. Separate strata for synthetic ground truth, blinded human rating and LLM judges. Registry entries are committed before runs and are immutable afterwards. Reports include raw counts, intervals, abstentions and missing data.
**Explicit non-goals.** No single “Yuvi-likeness” score. Judges cannot certify lived quality.
**Code/docs to inspect.** [YUVI behavior eval](YUVI_BEHAVIOR_EVAL.md) (historical assets), research methodology.
**Required invariants.** The judge model family differs from the generator and subject where feasible, and blinding is verified.
**Failure semantics.** A missing preregistration marks results exploratory only.
**Required tests.** Blinding leak check; a registry entry cannot be edited after its run starts.
**Migration/compatibility.** Historical behavior assets may be imported with a legacy label.
**Exit criteria.** Probe suite v1, registry and report template are used by one dry-run experiment.
**Downstream.** E1a, P1, C1.
**Not yet.** Real-user longitudinal data (needs PV1).

## E1a *(gate)* — Long-context length and provenance scan

**Goal.** Run E1 arms B0, B0p and B1 over increasing history length, noise and provenance quality.
**Why it exists.** It locates how much continuity plain long context plus provenance already delivers, and whether model priors dominate (R1).
**Preconditions.** M2; preregistration committed.
**Existing authority to preserve.** Production prompts are unchanged. B0 is a research control, not permission to dump raw logs into production.
**Exact scope.** Length sweep; provenance variants (none, receipt-level, receipt+identity+audience); fixed model/task/charter/budget; cost and latency.
**Explicit non-goals.** L2/S/B2 arms, which are added by P3 and C4.
**Code/docs to inspect.** Selection comparators table; A4 canonical context.
**Required invariants.** Same access rights for every arm; no hindsight evidence.
**Failure semantics.** If B0p meets frozen targets at a feasible length, record that. Later arms must beat it to justify themselves.
**Required tests.** Arm isolation; leakage audit.
**Migration/compatibility.** None.
**Exit criteria.** A published report with the stop/continue decision recorded against its preregistration.
**Downstream.** P1 and C1 proceed. A positive B0p result raises the bar they must clear; it does not cancel obligation machinery that is needed for correctness.
**Not yet.** Z or learned selection.

## P1 — Typed prospective items and reducer

**Goal.** Implement COMMITMENT, EXPECTATION and INTENTION as typed items with one Runtime-owned reducer.
**Why it exists.** Prospective continuity (what remains owed or expected) matters more than simulated affect ([prospective continuity](prospective-continuity.md)).
**Preconditions.** v0.1.3 journal/outbox; M2 probes for obligations.
**Existing authority to preserve.** Runtime admission. P6 proactive gate stays the sole proactive text authority.
**Exact scope.** Schema (ID, type, responsible party, beneficiary, audience inherited from source evidence, terms reference, closure predicate, TTL for INTENTION, revision); admission rules (a generated “I promise” is only a proposal); transitions proposed → active → fulfilled/canceled/failed/expired/unknown; closure events recorded as evidence.
**Explicit non-goals.** Scheduling (P2), OPEN_THREAD (P3), proactive messaging changes.
**Code/docs to inspect.** Runtime admission, journal kinds, [prospective continuity](prospective-continuity.md).
**Required invariants.** Only items with recognizable closure conditions become durable. INTENTION cannot gain commitment authority through repetition. Visibility never widens beyond its source.
**Failure semantics.** Missing terms → no commitment. Unknown delivery of the acceptance message is recorded separately from the obligation.
**Required tests.** Admission refusal for vague terms; illegal transitions; private commitment not visible in group context; stale model completion cannot reopen a closed item.
**Migration/compatibility.** Existing reminders are not renamed into commitments.
**Exit criteria.** The reducer passes the transition matrix on the durable store; every closure appends evidence.
**Downstream.** P2.
**Not yet.** Initiative that acts on items.

## P2 — Time, due work and restart for prospective items

**Goal.** Durable due/review scheduling with restart, clock and absence handling.
**Why it exists.** Obligations fail at time boundaries: restarts, clock changes, long absence.
**Preconditions.** P1.
**Existing authority to preserve.** A2 does not resume old executions. P6 user priority.
**Exact scope.** Scheduling keyed by item/revision/trigger; restart re-evaluates permissions, membership and deadlines; offline time produces an overdue *review*, never a burst of old outbound messages.
**Explicit non-goals.** Autonomous outreach policy.
**Code/docs to inspect.** Runtime proactive policy, journal recovery table.
**Required invariants.** I2/I3 on any resulting effect; no duplicate trigger after restart.
**Failure semantics.** Ambiguous triggers → review state, not an action.
**Required tests.** Clock rollback and skew, a two-week absence under the accelerated clock, cancellation race, unknown send outcome.
**Migration/compatibility.** None.
**Exit criteria.** The M1 replay of obligation-heavy histories shows zero duplicate or leaked triggers.
**Downstream.** P3.
**Not yet.** Engagement-driven reminders.

## P3 — OPEN_THREAD projection and B0p+L2 evaluation

**Goal.** A decaying derived OPEN_THREAD view, plus the E1 B0p+L2 arm.
**Why it exists.** It measures how much apparent continuity was simply missing obligation machinery.
**Preconditions.** P2, E1a.
**Existing authority to preserve.** A4 remains the single context assembler; OPEN_THREAD is a projection with no writer.
**Exact scope.** Recomputed projection over receipts and typed items; decay policy; context-manifest entries; E1 L2 arm under preregistration.
**Explicit non-goals.** A durable immortal backlog.
**Code/docs to inspect.** A4 assembler, A10.3 manifest.
**Required invariants.** Audience propagation; no leakage from private to group.
**Failure semantics.** A missing source leaves the projection partial, with the gap stated.
**Required tests.** Decay, recomputation equality, visibility.
**Migration/compatibility.** None.
**Exit criteria.** The L2 arm is reported against B0p with the decision recorded.
**Downstream.** MR1.
**Not yet.** Selection learning.

## C1 — Codebook, evidence pointers and state-blind annotator harness

**Goal.** A frozen closed-label codebook and an annotator harness that emits DERIVATION proposals with selectors, and no state.
**Why it exists.** Models should act as bounded measurement instruments, not state writers.
**Preconditions.** M2; A10.1 lineage invariant.
**Existing authority to preserve.** Journal commit gate. The annotator proposes; the gate commits.
**Exact scope.** Labels for concrete propositions (promise made/fulfilled/broken, requested help provided, conflict, repair, disclosure, explicit boundary, correction); episode segmentation policy; annotator input limited to a local evidence window with **no** current projection, support count or prior answers; outputs are labels, selectors, abstention and version metadata.
**Explicit non-goals.** Integration or accumulation (C2), trait names, `trust += x` outputs.
**Code/docs to inspect.** [Measured consolidation](measured-consolidation.md), journal selectors.
**Required invariants.** Self-generated prose is never evidence of YUVI's own disposition. Hearsay keeps assertor ≠ subject. Assistant-elicited evidence is stratified.
**Failure semantics.** An invalid selector means rejection; ambiguity means abstention.
**Required tests.** Blindness check (state not present in the prompt); forged selector rejected; model-invented source rejected.
**Migration/compatibility.** None.
**Exit criteria.** Codebook v1 frozen; harness produces committed DERIVATIONs on M1 histories.
**Downstream.** E2.
**Not yet.** Persistent variables.

## E2 *(gate)* — Codebook reliability pilot

**Goal.** Measure annotation reliability per [research methodology E2](research-methodology.md#required-experiments).
**Why it exists.** Unreliable labels cannot feed persistent state (R7, R8).
**Preconditions.** C1; preregistered floors.
**Existing authority to preserve.** None is changed.
**Exact scope.** Repeated runs, two or more model families, human adjudication, per-label precision/recall, a systematic-bias check across model families (R7), and a construct review of what the codebook omits (R8).
**Explicit non-goals.** Tuning the codebook on the test set.
**Required invariants.** Thresholds frozen before the run.
**Failure semantics.** Failure blocks C2 for the failing labels. There is no “lower confidence” workaround.
**Code/docs to inspect.** C1 outputs, M2 registry.
**Required tests.** Inter-annotator statistics, rare-negative coverage.
**Migration/compatibility.** Codebook revisions create a new version and require a new pilot.
**Exit criteria.** A per-label pass/fail list is committed.
**Downstream.** C2 (passing labels only), O1.
**Not yet.** Any integrator.

## C2 — Deterministic governed accumulator (shadow)

**Goal.** A versioned deterministic reducer over passing labels, running in shadow with no reader.
**Why it exists.** Accumulation must be bounded, independent-evidence aware and replayable, not LLM-judged.
**Preconditions.** E2 pass for the labels used.
**Existing authority to preserve.** The integrator is the sole writer of its projections ([authority](authority.md)); P8 remains unchanged.
**Exact scope.** Measurement definition for each variable (construct, unit, denominator, independence rule, update bound, decay, correction rule, owner); per-epoch caps; exposure stratification; replay equality.
**Explicit non-goals.** Context exposure, stored “trust” or any variable without a definition.
**Code/docs to inspect.** Measured consolidation; journal DERIVATION.
**Required invariants.** Repetition of one event cannot increase support; assistant output is excluded as self-evidence.
**Failure semantics.** A missing definition blocks that variable. Correction invalidates descendants.
**Required tests.** Replay determinism, duplicate insensitivity, correlated-source handling, cap enforcement.
**Migration/compatibility.** Shadow only.
**Exit criteria.** The shadow projection is reproducible from the journal and invalidates correctly under amendment.
**Downstream.** C3.
**Not yet.** Promotion to context.

## C3 — Construct-specific promotion and measured projections

**Goal.** Fix promotion count, gap, cap and decay per construct in the codebook, then produce measured projections.
**Why it exists.** It turns noisy annotations into bounded, auditable projections.
**Preconditions.** C2.
**Existing authority to preserve.** As C2.
**Exact scope.** Promotion rules frozen before results; rollback to the previous version.
**Explicit non-goals.** Relationship scalars and psychological labels as primitives.
**Code/docs to inspect.** Measured consolidation.
**Required invariants.** Promotion requires multiple independent episodes across sessions and separated time windows.
**Failure semantics.** An undefined construct blocks promotion.
**Required tests.** Single intense session cannot promote; decay; rollback.
**Migration/compatibility.** Versioned; old versions remain interpretable.
**Exit criteria.** Projections for the passing constructs exist with complete lineage.
**Downstream.** C4, E4, E5, S1.
**Not yet.** Reading by production context.

## C4 — Projection rendering into context and B2 / B0p+S evaluation

**Goal.** Render measured projections into the A4 context with provenance and uncertainty; run the E1 B0p+S and B2 arms.
**Why it exists.** It tests whether explicit projections add anything over B0p and B0p+L2.
**Preconditions.** C3, P3.
**Existing authority to preserve.** A4 single assembler; P8 relationship projection until PM1.
**Exact scope.** Read-only renderer; manifest entries; E1 arms under preregistration.
**Explicit non-goals.** Replacing P8 fields (PM1 does that).
**Code/docs to inspect.** Canonical context, P8 ownership map.
**Required invariants.** Rendered words are summaries of named measurements, not primitive state.
**Failure semantics.** A stale projection is withheld during pending correction.
**Required tests.** Manifest completeness; withholding during amendment.
**Migration/compatibility.** Feature-flagged, off by default until PM1 for the corresponding field.
**Exit criteria.** B2 / B0p+S report with a decision. A null result retires the projection.
**Downstream.** E6, RD1, MR1.
**Not yet.** Learned selection.

## E6 *(gate)* — Attribution correction and descendant invalidation

**Goal.** Introduce wrong evidence or a wrong binding, derive from it, amend it, and verify that stale descendants stop influencing behavior.
**Preconditions.** C4, P3.
**Why it exists.** Correctability is part of the core research question.
**Existing authority to preserve.** Each owner recomputes its own meaning.
**Exact scope, tests, exit.** Follows the E6 row in [research methodology](research-methodology.md#required-experiments). Global reset or lingering influence is failure.
**Explicit non-goals / not yet.** No deletion cascade (PV1).
**Code/docs to inspect.** Memory and lineage correction worklist.
**Required invariants.** Unrelated history and obligations preserved.
**Failure semantics.** Any lingering affected influence blocks MR1.
**Migration/compatibility.** None.
**Downstream.** MR1.

## E4 *(gate)* — Manipulation effect versus attacker budget

**Goal / scope.** The E4 curves in research methodology, run against C3 projections and against B0p.
**Why it exists.** R4, and genuine sustained influence versus manipulation.
**Preconditions.** C3. **Authority to preserve.** Charter; disclosure.
**Non-goals.** A binary “robust” label. **Code/docs to inspect.** Research methodology, E4 row.
**Invariants.** Forged provenance is separated from genuine sustained interaction. **Failure semantics.** Report cost curves; unbounded influence at low budget blocks exposure of that construct.
**Tests.** Attacker event, source, time and share sweeps. **Migration.** None. **Exit.** Published curves plus a decision per construct.
**Downstream.** S1 exposure policy, Z1. **Not yet.** Automated defenses that modify evidence.

## E5 *(gate)* — Pulse response and decay

**Goal / scope.** Inject one controlled experience; measure immediate effect, integration, persistence, decay and recovery over accelerated time (E5 row).
**Why it exists.** It tests whether bounded durable change exists at all, without endless self-reinforcement.
**Preconditions.** C3, M1. **Authority to preserve.** Integrator bounds.
**Non-goals.** Hidden refresh. **Code/docs to inspect.** Research methodology, E5 row.
**Invariants.** Self-generated reminders produce no reinforcement. **Failure semantics.** Endless reinforcement or no measurable effect is recorded as failure for that construct.
**Tests.** No-pulse, single-pulse and repeated-pulse arms. **Migration.** None. **Exit.** Report plus decision.
**Downstream.** RD2. **Not yet.** Revealed disposition.

## S1 — Explicit selection baselines: B3 and Zero

**Goal.** Strong heuristic selection (recency, frequency, importance, open obligations, retrospective relevance offline only) and a Zero control, with full exposure logging.
**Why it exists.** Learned selection must beat strong explicit competitors.
**Preconditions.** C3; A10.3 exposure logs.
**Existing authority to preserve.** A4 assembler; Memory retrieval owner.
**Exact scope.** Selection policies as versioned, swappable components; logs of candidates, exposure and omitted evidence; concentration/entropy metrics (R4).
**Explicit non-goals.** Learned parameters.
**Code/docs to inspect.** Memory retriever, selection research.
**Required invariants.** No future-looking live features.
**Failure semantics.** A logging gap invalidates the run.
**Required tests.** Leakage-safe time splits; entropy tracking.
**Migration/compatibility.** Production retrieval unchanged unless B3 wins under preregistration.
**Exit criteria.** B3/Zero reports are available to S2.
**Downstream.** S2, RD1.
**Not yet.** Z.

## S2 / E3 *(gate)* — State ablation and oracle gap

**Goal.** E3: remove persistent state with inputs fixed, swap relevant and unrelated evidence, and compare O_text, O_selection, B3 and Zero.
**Why it exists.** It decides whether selection has headroom that learning could close.
**Preconditions.** S1, C4.
**Existing authority to preserve.** Oracles live only in the harness.
**Exact scope / tests / exit.** Per the E3 row in research methodology. The decision is recorded: an O_text-only gain routes to readout work; no meaningful O_selection gap over B3 means **stop Z**.
**Explicit non-goals.** Building Z.
**Code/docs to inspect.** Selection research gates 2–3.
**Required invariants.** No hindsight leakage.
**Failure semantics.** An ambiguous result counts as no gap.
**Migration/compatibility.** None.
**Downstream.** Z1 only if a gap exists; otherwise the latent path closes.
**Not yet.** Z training.

## PV1 — Deletion cascade and research-data admissibility

**Goal.** Cross-store deletion propagation (journal payloads, Memory indexes, projections, manifests, research datasets), plus consent and admissibility records.
**Why it exists.** R5. It is required before non-synthetic longitudinal research, Z training or real holdouts.
**Preconditions.** v0.1.3 retention states; A10.3 lineage.
**Existing authority to preserve.** Each store owner deletes its own data. The journal keeps redaction markers, not content.
**Exact scope.** Deletion worklist over lineage; crypto-shredding if chosen; dataset versioning; retrain-or-reject rule for learned artifacts.
**Explicit non-goals.** Promises about already delivered remote messages or third-party models.
**Code/docs to inspect.** Life-event journal retention; Memory forget paths.
**Required invariants.** Tombstoning with retained learned influence is not deletion.
**Failure semantics.** An undeletable dependency blocks that data use.
**Required tests.** Delete a source and verify descendants, indexes and dataset membership are removed; missingness is shown in reconstruction.
**Migration/compatibility.** Existing forget paths are wrapped, not duplicated.
**Exit criteria.** The deletion suite passes across all stores.
**Downstream.** Z1, RD2 on real data, MR1 real holdouts.
**Not yet.** None.

## Z1 *(gate, optional)* — Offline learned selection trial

**Goal.** Only if S2 found a frozen minimum O_selection gap: test whether a small offline Z closes a meaningful part of it on held-out histories.
**Preconditions.** S2 gap, PV1, E4 curves.
**Existing authority to preserve.** Z has no facts, bindings, obligations or charter authority.
**Exact scope.** Artifact manifest (training event IDs, objective, features, seed, deletion procedure); cost, error and manipulation budgets.
**Explicit non-goals.** Deployment, identity vectors.
**Code/docs to inspect.** Selection research gates 4–5.
**Required invariants.** Replayable, retrainable after deletion, tested after correction.
**Failure semantics.** Any gate failure rejects Z.
**Required tests.** Held-out histories; deletion retrain; correction.
**Migration/compatibility.** Research artifact only.
**Exit criteria.** Decision recorded.
**Downstream.** MR1 repeats with Z if it passed.
**Not yet.** Production Z.

## RD1 — Counterfactual choice-set and propensity logging

**Goal.** Log genuine choice opportunities: available alternatives, scarce resource cost, whether user or task mandated the choice, the pre-choice policy and its predicted propensity. No state is written.
**Why it exists.** R2 self-evidence starvation. It is the precondition for testing revealed disposition.
**Preconditions.** C4, S1.
**Existing authority to preserve.** Runtime DECISION events; charter.
**Exact scope.** DECISION payload extensions; mandated/task-determined exclusion flags; negative evidence (ignored options, abandoned intentions).
**Explicit non-goals.** Any disposition update.
**Code/docs to inspect.** Measured consolidation, revealed disposition section.
**Required invariants.** Logged **before** the choice; existing disposition-predicted behavior is marked as predicted.
**Failure semantics.** A missing pre-choice record makes the choice ineligible.
**Required tests.** Ordering (pre-choice log precedes action); exclusion flags.
**Migration/compatibility.** Additive.
**Exit criteria.** The M1 replay produces eligible choice records with propensities.
**Downstream.** RD2.
**Not yet.** Exploration.

## RD2 *(gate)* — Residual revealed-disposition experiment (shadow)

**Goal.** Test whether residual innovation beyond the existing policy, over repeated independent opportunities with negative evidence, supports tiny bounded epoch updates.
**Preconditions.** RD1, E5; PV1 if real data is used.
**Existing authority to preserve.** Integrator bounds. Shadow only.
**Exact scope.** Residual estimation, uncertainty from counterfactual model error, epoch batching, ablation removing the supposed innovation.
**Explicit non-goals.** Production disposition state.
**Code/docs to inspect.** Measured consolidation.
**Required invariants.** No recursive self-confirmation; a state that predicted a choice cannot count that choice as support.
**Failure semantics.** Unestablished independence or counterfactual validity means no promotion.
**Required tests.** Self-confirmation loop simulation must stay flat.
**Migration/compatibility.** None.
**Exit criteria.** Decision recorded.
**Downstream.** X1 (only if informative).
**Not yet.** Exploration.

## X1 *(research)* — Charter-constrained exploration channel

**Goal.** A small, resource-limited exploration channel that creates informative choice opportunities not selected by the user.
**Preconditions.** RD2 shows that residual evidence is measurable.
**Existing authority to preserve.** Runtime admission; P6 or its explicit replacement; charter.
**Exact scope.** Explicit budget; journaled effects; no commitment creation.
**Explicit non-goals.** Engagement or retention objectives as learning signals; compulsive messaging.
**Code/docs to inspect.** Measured consolidation, exploration section.
**Required invariants.** Exploration choices are labeled as such and weighted separately.
**Failure semantics.** A budget breach halts the channel.
**Required tests.** Budget enforcement; no retention metric in the objective.
**Migration/compatibility.** Off by default.
**Exit criteria.** Research report.
**Downstream.** None mandatory.
**Not yet.** Production initiative.

## MR1 — Model replacement continuity release gate

**Goal.** Paired frozen histories across old and new models on four axes: factual/obligation, relationship/preference, normative, style.
**Preconditions.** P3, C4, E6; PV1 for real holdouts.
**Existing authority to preserve.** Evidence and obligations stay outside the model.
**Exact scope / tests / exit.** Per [model replacement](model-replacement.md). Zero critical failures in the release suite; style reported separately.
**Explicit non-goals.** Fine-tuning to hide pipeline defects.
**Code/docs to inspect.** Provider adapters, A4.
**Required invariants.** No single likeness score.
**Failure semantics.** A factual or normative failure blocks replacement.
**Migration/compatibility.** Presentation adapters are versioned and never mutate evidence.
**Downstream.** PM1, and every future model swap.
**Not yet.** Post-training.

## PM1 — P8 field-by-field migration

**Goal.** Migrate one P8 field at a time per the [ownership map](p8-ownership.md), once its replacement authority exists.
**Preconditions.** The replacement owner for that field passed its gates (for example, C4 plus E6 for relationship context); MR1.
**Existing authority to preserve.** The current P8 writer until the switch; explicit corrections keep working.
**Exact scope.** Shadow → compare → atomic switch → remove old derivation, for one field per atom instance.
**Explicit non-goals.** Bulk migration; new P8 fields.
**Code/docs to inspect.** P8 package, correction store.
**Required invariants.** No dual authority at any time.
**Failure semantics.** Comparison mismatch means no switch. Rollback restores the previous owner.
**Required tests.** Equivalence report; correction within one turn; rollback.
**Migration/compatibility.** Per field.
**Exit criteria.** The field's old writer or derivation is deleted and the map is updated.
**Downstream.** Eventual P8 retirement.
**Not yet.** Deleting authored charter content.

## O1 *(optional research)* — Open-vocabulary hypothesis queue

**Goal / scope.** Per [measured consolidation](measured-consolidation.md#optional-hypotheses): a model proposes a named pattern with selectors and a disconfirmation plan. It enters a pending research queue, which is not state.
**Preconditions.** E2. **Authority to preserve.** No new variables without measurement definitions.
**Non-goals.** Automatic instantiation. **Invariants.** Failed or expired hypotheses are deleted.
**Failure semantics.** A hypothesis never mapped to a definition expires. **Tests.** Expiry; no state write.
**Code/docs to inspect.** Measured consolidation. **Migration.** None. **Exit.** Queue operational in research mode.
**Downstream.** New codebook versions via C1/E2. **Not yet.** Production use.

## Permanently excluded

Persistent self or self vectors, a generic Life Layer, a generic regulation substrate, artificial hormones or neurotransmitter variables, desire or social-need meters, a stored generic trust variable, a “Yuvi-likeness” score, and engagement or retention optimization. 岁月感 and 第一人称生活实感 remain **LONG-TERM EVALUATION GOALS** measured by M2 probes. They are not modules.
