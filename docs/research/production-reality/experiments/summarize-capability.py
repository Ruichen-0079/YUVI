"""Safe summary of actual normal-entry capability trials; no prompt disclosure.
Usage: summarize-capability.py PRIVATE_ROOT PUBLIC_JSON
"""
import hashlib
import json
from pathlib import Path
import sys

root, destination = map(Path, sys.argv[1:3])
cases = json.loads((root / 'partial-read-cases.json').read_text())
states = json.loads((root / 'partial-durable-state.json').read_text())
report = {'schema': 'normal-entry-capability-comparison.v1',
          'request': cases['turns'][0], 'markers': cases['markers'],
          'fileDigest': hashlib.sha256(cases['fileContent'].encode()).hexdigest(),
          'authorization': 'isolated operator control, single file, not product Host credentials',
          'kind': 'REAL_MODEL_CHOICES_NORMAL_SERVER_REAL_HOST_READ', 'runs': [],
          'limitations': ['Small controlled trials, not general model autonomy accuracy',
                         'Default GLM busy response retained; no fallback hidden',
                         'Reasoning budget 1 is an experiment configuration only',
                         'No private Alice persona, memory, image, credentials or configuration used']}
for name in ['partial-read2', 'partial-read3', 'partial-read4', 'partial-read5', 'partial-read6', 'partial-read7', 'partial-read8', 'partial-read9']:
    directory = root / name
    result = json.loads((directory / 'result.json').read_text())
    run_cases = json.loads((root / 'partial-read-final-cases.json').read_text()) if name in ['partial-read7','partial-read8','partial-read9'] else cases
    calls = []
    for file in sorted((directory / 'wire-calls').glob('call-*.json'), key=lambda p: int(p.stem.split('-')[-1])):
        raw = json.loads(file.read_text())
        events = []
        try:
            events.append(json.loads(raw.get('output', '{}')))
        except ValueError:
            for line in raw.get('output', '').splitlines():
                if line.startswith('data: {'):
                    events.append(json.loads(line[6:]))
        usage = next((e['usage'] for e in reversed(events) if e.get('usage')), None)
        input_ = raw['effectiveInput']
        messages = input_['messages']
        encoded = json.dumps(messages, ensure_ascii=False, separators=(',', ':')).encode()
        control = None
        if not input_.get('stream') and events and events[0].get('choices'):
            control = events[0]['choices'][0]['message']['content']
        cognition_status = None
        for message in messages:
            text = message['content']
            prefix = 'Semantic context:\n'
            if prefix in text:
                try:
                    context = json.loads(text.split(prefix, 1)[1])
                    cognition_status = next((s['result']['status'] for s in context['sections'] if s['kind'] == 'COGNITION_RESULT'), None)
                except (ValueError, KeyError):
                    pass
        calls.append({'ordinal': int(file.stem.split('-')[-1]), 'stream': input_.get('stream', False),
                      'model': input_['model'], 'httpStatus': raw.get('httpStatus'), 'error': raw.get('error'),
                      'inputDigest': hashlib.sha256(encoded).hexdigest(), 'inputBytes': len(encoded),
                      'fileMarkersInInput': [m in str(messages) for m in run_cases['markers']],
                      'controlOutput': control, 'cognitionStatusInInput': cognition_status,
                      'usage': usage, 'latencyMs': raw.get('latencyMs'),
                      'firstTextMs': raw.get('firstTextMs')})
    final = result['turns'][-1]['result'].get('payload', {}).get('content', '')
    state = next(s for s in states if s['instanceId'] == 'pr-experiment-' + name)
    report['runs'].append({'name': name, 'gitSha': result['gitSha'], 'dirty': result['dirty'],
                          'markers': run_cases['markers'], 'chatModel': result['model'], 'reasoningModel': result['reasoningModel'],
                          'temperature': 0, 'maxTokens': 2048, 'maxReasoningRounds': 1,
                          'calls': calls, 'readEffects': state['readEffects'], 'finalAnswer': final,
                          'markersCorrect': all(m in final for m in run_cases['markers']),
                          'knownEstimatedCostUSD': sum(float((c['usage'] or {}).get('estimated_cost') or 0) for c in calls),
                          'estimatedCostUSD': None if any(c['usage'] is None for c in calls) else sum(float(c['usage'].get('estimated_cost') or 0) for c in calls),
                          'unknownUsageCalls': sum(c['usage'] is None for c in calls)})
destination.write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps([{k: r[k] for k in ['name','markersCorrect','estimatedCostUSD','unknownUsageCalls']} for r in report['runs']], indent=2))
