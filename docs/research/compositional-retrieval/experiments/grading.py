"""Evaluation precedence only; not a Runtime semantic judge."""
import re
def responsibility_stage(*, formed, current, authorized, channel, candidate, selected, context, answer):
    if not authorized: return 'AUTHORIZED_UNKNOWN'
    if not formed: return 'NOT_FORMED'
    if not current: return 'NOT_CURRENT'
    if not channel and not candidate: return 'CHANNEL_CANDIDATE_MISS'
    if not selected: return 'FUSION_OR_RESULT_BOUND'
    if not context: return 'CONTEXT_DROP'
    if not answer: return 'ANSWER_GROUNDING_ERROR'
    return 'CORRECT_VALUE'
def shortest_label_contradiction(answer):
    return bool(re.search(r'(?:A[:：]\s*12|Bar A[:：]\s*12)[^\n]{0,80}shortest',answer,re.I))
def observation_stage(*, report_correct, entered_context, question_supported, answer_consistent):
    if not report_correct: return 'OBSERVATION_ERROR'
    if not entered_context: return 'CONTEXT_DROP'
    if not question_supported:
        return 'CORRECT_ABSTENTION' if answer_consistent else 'UNSUPPORTED_HALLUCINATION'
    return 'GROUNDED' if answer_consistent else 'ANSWER_GROUNDING_ERROR'
