"""Publish only synthetic answers and bounded metadata, never full prompts/headers.
Usage: summarize-dialogue.py PRIVATE_ROOT PUBLIC_EVIDENCE_DIR
"""
import csv
import hashlib
import json
from pathlib import Path
import sys

root, target = map(Path, sys.argv[1:3])
target.mkdir(parents=True, exist_ok=True)
cases = json.loads((root / 'long-cases.json').read_text())
summary = {'schema': 'production-continuity-comparison.v1', 'marker': cases['marker'],
           'kind': 'REAL_PROVIDER_NORMAL_SERVER_NOT_SCRIPTED_QUALITY',
           'casesDigest': hashlib.sha256((root / 'long-cases.json').read_bytes()).hexdigest(),
           'cases': cases, 'runs': [], 'limitations': [
               'One 30-turn series per version, same user inputs; remote model is not deterministic',
               'No Memory/Host product proof; memory read/write disabled to isolate Conversation',
               'Input bytes are conservative budgeting evidence, not measured tokenizer counts',
               'Estimated Provider cost is not the final invoice; startup failures are retained privately']}
rows = []
for name in ['live-before', 'live-after4']:
    run_root = root / name
    result = json.loads((run_root / 'result.json').read_text())
    calls = []
    for file in sorted((run_root / 'wire-calls').glob('call-*.json'), key=lambda x: int(x.stem.split('-')[-1])):
        raw = json.loads(file.read_text())
        events = []
        try:
            events.append(json.loads(raw.get('output', '{}')))
        except ValueError:
            for line in raw.get('output', '').splitlines():
                if line.startswith('data: {'):
                    events.append(json.loads(line[6:]))
        usage = next((event['usage'] for event in reversed(events) if event.get('usage')), {})
        input_ = raw.get('effectiveInput') or {}
        messages = input_.get('messages', [])
        encoded = json.dumps(messages, ensure_ascii=False, separators=(',', ':')).encode()
        index = int(file.stem.split('-')[-1])
        call = {'ordinal': index, 'stream': input_.get('stream', False),
                'model': input_.get('model'), 'httpStatus': raw.get('httpStatus'),
                'latencyMs': raw.get('latencyMs'), 'firstByteMs': raw.get('firstByteMs'),
                'firstTextMs': raw.get('firstTextMs'), 'inputBytes': len(encoded),
                'inputDigest': hashlib.sha256(encoded).hexdigest(),
                'initialFactPresent': cases['marker'] in str(messages),
                'roles': [m['role'] for m in messages],
                'inputTokens': usage.get('prompt_tokens'), 'outputTokens': usage.get('completion_tokens'),
                'cachedInputTokens': (usage.get('prompt_tokens_details') or {}).get('cached_tokens'),
                'estimatedCostUSD': usage.get('estimated_cost'),
                'finishReasons': [c['finish_reason'] for event in events for c in event.get('choices', []) if c.get('finish_reason')]}
        calls.append(call)
        rows.append({'run': name, **{k: v for k, v in call.items() if k not in ['roles', 'finishReasons']}})
    final = result['turns'][-1]['result'].get('payload', {}).get('content', '')
    summary['runs'].append({'name': name, 'gitSha': result['gitSha'], 'dirty': result['dirty'],
        'persona': result['persona'], 'model': result['model'], 'contextWindow': result['declaredContextWindow'],
        'temperature': result['temperature'], 'maxTokens': result['maxTokens'], 'status': result['status'],
        'turns': len(result['turns']), 'turnsSucceeded': sum(t['httpStatus'] == 200 for t in result['turns']),
        'finalAnswer': final, 'finalAnswerContainsSource': cases['marker'] in final,
        'modelCalls': len(calls), 'usageKnownCalls': sum(c['inputTokens'] is not None for c in calls),
        'inputTokens': sum(c['inputTokens'] or 0 for c in calls),
        'outputTokens': sum(c['outputTokens'] or 0 for c in calls),
        'estimatedCostUSD': sum(float(c['estimatedCostUSD'] or 0) for c in calls),
        'firstFactReachedLastGateAndBody': all(c['initialFactPresent'] for c in calls[-2:]),
        'calls': calls})
(target / 'model-comparison.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
with (target / 'model-calls.csv').open('w') as file:
    writer = csv.DictWriter(file, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
print(json.dumps([{k: r[k] for k in ['name','gitSha','dirty','status','turns','modelCalls','finalAnswer','finalAnswerContainsSource','firstFactReachedLastGateAndBody','estimatedCostUSD']} for r in summary['runs']], ensure_ascii=False, indent=2))
