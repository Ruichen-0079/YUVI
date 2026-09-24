# Measured consolidation and disposition hypotheses

Status: **PRODUCTION ARCHITECTURE DECISION** for authority restrictions; **PLANNED ENGINEERING** for explicit consolidation after its reliability gate; **RESEARCH HYPOTHESIS** for open-vocabulary and revealed-disposition extensions. No durable psychology variables are authorized here.

## Four stages with separate writers

1. **Episode segmentation.** A versioned policy groups committed receipts/actions/outcomes into bounded episodes, preserving participants, audiences, time uncertainty, causal links and selection/exposure provenance. It does not summarize away contradictions. Episode independence is a recorded hypothesis: separate sessions alone do not establish independent sources.
2. **State-blind local annotation.** A bounded annotator sees the eligible local evidence window and codebook, not the current projection, desired trait, accumulated support count or previous annotator answer. It returns only closed labels, source selectors, ambiguity/abstention and measurement metadata. It cannot emit a state delta or choose its own promotion threshold.
3. **Governed integration.** A deterministic versioned reducer consumes validated annotations and eligibility records. It applies bounded updates, independent-session/time requirements, exposure corrections, contradictions and decay, and commits a DERIVATION. Human/governed interventions are separate explicit commands, not an LLM “judge” secretly changing weights.
4. **Projection.** A read-only renderer translates retained evidence and qualified tendencies into contextual language with provenance and uncertainty. Words such as “interested,” “cautious” or “familiar” are summaries of specified measurements, not primitive stored psychology.

A measurement definition must precede every persistent variable. It states construct, observable unit, allowed source classes, competing explanations, labels and examples/counterexamples, abstention, measurement error, eligible opportunity denominator, independence rules, update bound, decay/time basis, correction rule, policy owner, versions and intended readers. No `trust = 0.73`, hormones, needs, fatigue, affinity, desire or emotion scalar can bypass this requirement. Operational counters such as pending delivery count remain operational, not inferred psychology.

A possible *pilot*, not an adopted trait: “voluntary continuation of a topic after a genuine choice opportunity.” The codebook must distinguish user-mandated continuation, task necessity, repeated prompting, no competing option, and unsolicited independent choice. Until E2 establishes reliable labels, the pilot is annotations only. Ordinary expressed human preferences remain attributed claims and need not be transformed into a psychological vector.

## Reliability and history

E2 freezes a codebook and failure thresholds before an integrator exists. Annotator/model/prompt/codebook versions accompany every annotation. Failed or ambiguous labels abstain. Repetition of the same event cannot increase evidence count. Correlated copies, assistant output and assistant-created summaries are not fresh independent evidence. An LLM can provide noisy local measurements; it is neither a ground-truth judge nor the writer of persistent state.

Changing a codebook creates a new measurement version. Historical annotations remain interpretable under the old one. Re-annotation and replay form a shadow branch with explicit comparison; changing weights or labels silently in place is prohibited. Promotion selects one version atomically, and rollback restores the previous owner/version. The correction worklist invalidates descendants and rebuilds from eligible sources, preserving unrelated history.

No threshold chosen after seeing favorable results counts as preregistered. Initial engineering bounds (promotion needs multiple independent eligible episodes across at least two sessions and separated time windows; at most one bounded update per epoch) are safety limits to be tested, not evidence that repetition measures a disposition. The concrete construct-specific count, gap, cap and decay must be fixed in the codebook before C3. Failure to define them blocks that construct.

## Feedback controls

Selection and exposure are logged before behavior. The integrator knows which evidence the model saw, which options were offered, which action elicited a response, and which observations were absent. Evidence elicited by YUVI receives a separate stratum and cannot be counted as spontaneous support; unknown elicitation is conservative. Fixed small per-epoch caps, temporal decay, prospective holdouts and independent opportunities prevent a single intense session from rewriting a long-lived projection.

Track source/topic concentration, selection entropy, exposure rates and abstention. Compare observed frequencies with opportunity denominators; do not treat non-selection as absence of interest unless the option was available and perceived. Maintain an eligible exploration floor only in later charter-constrained experiments. A selector that repeatedly exposes its own favorite evidence creates a loop unless measured against an independent sampling policy.

## Optional hypotheses

**Open-vocabulary hypothesis queue:** a model may propose a named pattern plus source pointers and a prospective disconfirmation plan. It enters a pending research queue, not durable trait state. Novel wording cannot instantiate a new variable. A reviewer must map it to a measurement definition and freeze a prospective test; failed/expired hypotheses are deleted. This path is optional O1, after closed-label reliability, not a prerequisite for explicit consolidation.

**Revealed disposition:** later research may use a genuine choice among competing options with a scarce resource (time, attention or action budget). Log alternatives, availability, costs, charter, task requirements, existing policy and current disposition **before** the choice. Exclude user-mandated and task-determined choices. Estimate the predictable choice under the existing policy; only residual behavioral innovation can be candidate new evidence. An inaccurate counterfactual model makes that residual uncertain, not automatically meaningful.

Require repeated independent opportunities, out-of-session prospective prediction and negative evidence: options ignored, lost opportunities and intentions abandoned. Account for exposure/selection. Use tiny bounded epoch updates; do not let each choice reinforce the state that predicted it. Persistent changes need correction/replay and an ablation that removes the supposed innovation. If independence or counterfactual validity cannot be established, do not promote it.

**Exploration:** independent charter-constrained exploration may later create informative choice opportunities with explicit resource and action limits. It is not engagement maximization, compulsive messaging, reward for user dependence or a license to create commitments. It uses Runtime admission and ordinary journaled effects. No exploration ships in v0.1.3.
