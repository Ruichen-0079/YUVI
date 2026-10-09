"""形式反例；不模拟已训练的人工个体，不使用生产代码或模型凭据。"""
import json
import math
from pathlib import Path


def update(z, event):
    x, own_action, result = event
    return (math.tanh(.81 * z[0] + .23 * x + .17 * own_action * result),
            .97 * z[1] + .03 * (result - z[0] * own_action))


history = [(math.sin(i * .31), (i % 3) - 1, math.cos(i * .17)) for i in range(200)]
live = (0., 0.)
for event in history:
    live = update(live, event)
replayed = (0., 0.)
for event in history:
    replayed = update(replayed, event)
replay_error = max(abs(x - y) for x, y in zip(live, replayed))

# 同一状态全量交换同时改变两个领域，却没有任何跨领域状态动力耦合。
def independent_update(z, e):
    return (.8 * z[0] + .2 * e[0], .8 * z[1] + .2 * e[1])

left, right = (.2, -.7), (.9, .4)
before, after = list(left), list(right)
probe = (.6, -.5)
perturbed = (probe[0] + .001, probe[1])
u = independent_update(left, probe)
v = independent_update(left, perturbed)
cross_effect = v[1] - u[1]
# 可逆坐标旋转令表示看上去稠密、混合，不改变独立性事实。
rotate = lambda z: ((z[0] - z[1]) / math.sqrt(2), (z[0] + z[1]) / math.sqrt(2))

flow = lambda z, dt: z * math.exp(-dt / 30.)
direct_flow = flow(1., 60.)
split_flow = flow(flow(1., 20.), 40.)
bad_wakeup_update = lambda z: .8 * z
one_wakeup = bad_wakeup_update(1.)
two_wakeups = bad_wakeup_update(bad_wakeup_update(1.))

result = {
    "kind": "formal_counterexamples_only_no_model_experience_claim",
    "recurrence_vs_complete_replay": {
        "events": len(history), "initial_state_and_transition_shared": True,
        "max_absolute_state_error": replay_error,
        "scope": "已知转移、完整事件与初态；不证明实际长上下文 LLM 会正确重放。"
    },
    "whole_state_swap_does_not_prove_unity": {
        "two_domain_outputs_before": before,
        "two_domain_outputs_after_swap": after,
        "domain_1_event_effect_on_domain_2_state": cross_effect,
        "rotated_before": rotate(left), "rotated_after": rotate(right),
        "scope": "两个独立控制器拼接；混合坐标和全交换不能证明统一因果机制。"
    },
    "elapsed_time_partition": {
        "one_interval": direct_flow, "two_intervals": split_flow,
        "absolute_difference": abs(direct_flow - split_flow),
        "arbitrary_per_wakeup_one_step": one_wakeup,
        "arbitrary_per_wakeup_two_steps": two_wakeups,
        "scope": "说明时间分段伪差异；不声称所有内部状态应指数衰减。"
    }
}
assert replay_error == 0.
assert cross_effect == 0.
assert abs(direct_flow - split_flow) < 1e-12
assert one_wakeup != two_wakeups
Path(__file__).with_name("results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result, ensure_ascii=False, indent=2))
