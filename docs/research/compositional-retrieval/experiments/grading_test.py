import unittest
from grading import responsibility_stage,shortest_label_contradiction
class AttributionContract(unittest.TestCase):
    good=dict(formed=True,current=True,authorized=True,channel=True,candidate=True,selected=True,context=True,answer=True)
    def test_correct_answer_does_not_mask_retrieval_or_context_loss(self):
        self.assertEqual(responsibility_stage(**(self.good|dict(channel=False,candidate=False,selected=False))),'CHANNEL_CANDIDATE_MISS')
        self.assertEqual(responsibility_stage(**(self.good|dict(context=False))),'CONTEXT_DROP')
    def test_formation_and_authorization_are_not_retrieval_misses(self):
        for flag,stage in [('formed','NOT_FORMED'),('current','NOT_CURRENT'),('authorized','AUTHORIZED_UNKNOWN')]:
            self.assertEqual(responsibility_stage(**(self.good|{flag:False})),stage)
    def test_fusion_and_expression_are_separate(self):
        self.assertEqual(responsibility_stage(**(self.good|dict(selected=False))),'FUSION_OR_RESULT_BOUND')
        self.assertEqual(responsibility_stage(**(self.good|dict(answer=False))),'ANSWER_GROUNDING_ERROR')
        self.assertEqual(responsibility_stage(**self.good),'CORRECT_VALUE')
    def test_correct_order_later_does_not_erase_an_earlier_contradiction(self):
        self.assertTrue(shortest_label_contradiction('Bar A: 12 — a square (shortest of the three)\nBar B: 7 — shorter than A\nOrder: B, A, C.'))
        self.assertFalse(shortest_label_contradiction('A: 12\nB: 7\nC: 19\nThe shortest is B (7).'))
