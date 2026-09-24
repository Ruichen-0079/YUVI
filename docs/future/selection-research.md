# Evidence selection and optional learned Z

Status: **RESEARCH HYPOTHESIS** for gains from learned selection; **PRODUCTION ARCHITECTURE DECISION** for evidence/authority restrictions. Experiments are gated in the [roadmap](post-v0.1.3-roadmap.md); none is a v0.1.3 feature.

Selection asks which eligible history to present for a particular decision. It does not define who YUVI is. A model-independent `Z`, if justified, controls evidence ranking/selection only. It cannot contain authoritative facts, Person bindings, commitments, normative charter or an undeletable identity vector.

## Comparators

| Arm | Fixed meaning |
| --- | --- |
| B0 | Raw long-context history, bounded by tested length; research control, not permission to dump raw logs into production prompts |
| B0p | B0 with explicit receipt/claim provenance, identity/audience and time information |
| B0p+L2 | B0p plus explicit typed prospective continuity; no learned state |
| B0p+S | B0p plus explicit evidence-linked projections from frozen rules |
| B1 | Current production persona + Memory retrieval, pinned to a recorded implementation/model/config snapshot |
| B2 | Explicit measured consolidation pipeline plus lineage-aware retrieval; frozen codebook/integrator |
| B3 | Strong explicit selection using recency, frequency, importance, open obligations/threads and retrospective relevance |
| Zero | Simple frequency + recency + similarity control with fixed token budget and no learned persistent state |
| O_text | Oracle supplies a correct textual projection under a fixed evidence set; diagnoses representation/readout problems |
| O_selection | Oracle supplies the relevant eligible evidence under the same context budget; diagnoses selection headroom |
| Z | Optional learned model-independent selector, trained from authorized trace data, compared with all relevant explicit controls |

“S” denotes explicit projections, not a scalar self. L2 names the prospective baseline, not a new architecture layer. O_text and O_selection use benchmark truth only inside an evaluation harness. Oracles cannot access facts unavailable before the tested decision or override disclosure. Retrospective relevance labels are offline training/analysis data with leakage-safe time splits, never a live future-looking feature.

Hold model, task, charter, context/token budget and access rights fixed where comparators permit; report any unavoidable differences. Sweep history lengths, noise, provenance, event density and elapsed time rather than testing one convenient prompt length. Log retrieval candidates, actual exposure, rank scores and omitted evidence. Gains in verbosity, warm style or judge likeness do not establish useful continuity.

## Gates, in order

1. Test B0/B0p/B0p+L2/B0p+S/B1/B2 to locate gains from provenance, obligations and explicit state. If explicit mechanisms meet preregistered targets, ship the simplest adequate mechanism and close the latent path.
2. Strengthen B3 and compare Zero; run state-removal and source-intervention ablations. Establish that the selected historical evidence causally matters rather than merely correlating with model priors.
3. Compare O_text with O_selection. An O_text-only gain calls for better projection/readout. Without a meaningful O_selection gap over B3, **do not build learned selection**.
4. Only if a frozen minimum useful O_selection advantage exists may a small offline Z trial test whether learning closes a meaningful portion of that gap on held-out histories, with cost, error and manipulation budgets. A positive oracle gap is necessary, not sufficient.
5. Reject Z if it cannot be replayed, retrained after deletion, tested after correction, and reconstructed across model replacements. A deployment proposal needs prospective gains, concentration/entropy controls and no additional authority.

Z's versioned artifact must declare training event IDs/dataset version, admissibility/retention basis, objective, features, seed/checkpoint, selector version, model dependencies, source-deletion procedure and evaluation report. If data influence cannot be removed cheaply by exact replay, retrain on the permitted set; if that is infeasible, reject the design. A frozen vector with an opaque “identity” label is not an acceptable shortcut.

Even model-independent parameters can overfit one model's embedding geometry, prompt or response policy. Replacement tests must repeat O_selection/B3/Z under new models; [portability](model-replacement.md) is measured, not presumed. Learned state is expendable. Evidence, obligations and governed charter retain their own independent authorities.
