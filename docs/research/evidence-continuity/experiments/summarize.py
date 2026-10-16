"""Export only explicitly synthetic experiment results, never credentials or raw traces.
Usage: python3 summarize.py PRIVATE_ROOT NEW_PUBLIC_DIRECTORY
"""
import csv
import hashlib
import json
from pathlib import Path
import re
import sys

root, output = map(Path, sys.argv[1:])
output.mkdir(parents=True, exist_ok=False)
names = ['run-three', 'run-six', 'run-tool', 'run-tool-retain']
rows, summaries, inputs = [], [], []

def decode(record):
    payload = record.get('output', '')
    try:
        chunks = [json.loads(payload)]
    except ValueError:
        chunks = [json.loads(line[6:]) for line in payload.splitlines() if line.startswith('data: {')]
    usage = next((c['usage'] for c in reversed(chunks) if c.get('usage')), {})
    text = ''
    for c in chunks:
        for choice in c.get('choices', []):
            text += choice.get('message', choice.get('delta', {})).get('content') or ''
    return usage, text

def redact(value):
    return re.sub(r'/home/[^/\s]+/[^\s"\\]+', '[LOCAL_PATH]', value)

for name in names:
    run = root / name
    result = json.loads((run / 'result.json').read_text())
    states = result.get('authorityState', [])
    ids = {r['id']: f'p{i+1}' for i, r in enumerate(states)}
    def knowledge(records):
        return [{'id': ids.get(r['id'], r['id']), 'content': r['event']['content'],
                 'state': r.get('state'), 'version': r['version']} for r in records]
    summary = {k: result[k] for k in ['sha', 'dirty', 'models', 'provider', 'personaVersion', 'temperature', 'maxTokens', 'callCap', 'costCapUSD', 'status', 'usage']}
    summary['run'] = name
    summary['error'] = 'RESULT_EXPORT_SQL_COLUMN_CREATED_AT' if name == 'run-six' else result.get('error')
    summary['turns'] = [{'ordinal': t['ordinal'], 'input': t['input'], 'person': t['person'],
        'httpStatus': t['httpStatus'], 'elapsedMs': t['elapsedMs'],
        'answer': redact(t['response'].get('reply', t['response'].get('transport', ''))),
        'ingestion': {k: t.get('ingestion', {}).get(k) for k in ['status', 'last_error_code', 'rejected_propositions']},
        'knowledgeAfter': knowledge(t.get('knowledgeAfter', []))} for t in result['turns']]
    projection = {r['id']: r for r in result.get('projection', [])}
    summary['finalKnowledge'] = knowledge([{**r, 'state': projection.get(r['id'], {}).get('state')} for r in states])
    summary['relations'] = [{k: ids.get(r[k], r[k]) if k in ['from_id', 'to_id'] else r[k]
                            for k in ['from_id', 'to_id', 'kind', 'version']} for r in result.get('relations', [])]
    summary['retainedObservations'] = [{'kind': o['kind'], 'provider': o['provider'], 'model': o['model'],
        'expiresAt': o['expires_at'], 'erased': o['erased_at'] is not None,
        'textDigest': hashlib.sha256(o['evidence']['text'].encode()).hexdigest() if o.get('evidence') else None,
        'textCharacters': len(o['evidence']['text']) if o.get('evidence') else 0} for o in result.get('observations', [])]
    postrun = run / 'postrun-storage.json'
    summary['storageAudit'] = json.loads(postrun.read_text()) if postrun.exists() else None
    summary['retrievals'] = [{k: r[k] for k in ['status', 'watermark']} for r in result.get('retrievalEvidence', [])]
    summaries.append(summary)
    files = sorted(run.glob('*-calls/call-*.json'), key=lambda f: (int(f.parent.name.split('-')[1]), int(f.stem.split('-')[1])))
    for i, path in enumerate(files):
        record = json.loads(path.read_text())
        if not record['url'].endswith('/chat/completions'): continue
        body = record['effectiveInput']
        usage, text = decode(record)
        messages = body['messages']
        phase = 'SEMANTIC' if 'Evaluate every source' in messages[0]['content'] else 'BODY' if body.get('stream') else 'CONTROL_OR_REASONING'
        rows.append({'run': name, 'ordinal': i, 'phase': phase, 'model': body['model'], 'httpStatus': record.get('httpStatus'),
            'inputTokens': usage.get('prompt_tokens'), 'outputTokens': usage.get('completion_tokens'),
            'cachedInputTokens': (usage.get('prompt_tokens_details') or {}).get('cached_tokens'),
            'estimatedCostUSD': usage.get('estimated_cost'), 'firstByteMs': record.get('firstByteMs'),
            'firstTextMs': record.get('firstTextMs'), 'totalMs': record.get('latencyMs'),
            'inputBytes': len(json.dumps(messages, ensure_ascii=False).encode()), 'error': (record.get('error') or {}).get('name')})
        item = {'run': name, 'ordinal': i, 'phase': phase,
            'messages': [{'role': m['role'], 'utf8Bytes': len(str(m['content']).encode()),
                'digest': hashlib.sha256(str(m['content']).encode()).hexdigest()} for m in messages],
            'hasFileMarkers': 'BEGIN-05df868d' in json.dumps(messages),
            'hasRetainedReport': 'UNTRUSTED_PROVIDER_REPORT' in json.dumps(messages),
            'hasInitialEditor': '澄雨-a936d0' in json.dumps(messages, ensure_ascii=False),
            'requestsCapability': text.startswith('REQUEST_CAPABILITY'),
            'control': text if text.startswith(('REQUEST_CAPABILITY', 'COMPLETE')) else None}
        if phase == 'SEMANTIC':
            semantic = json.loads(messages[-1]['content'])
            item['semanticInput'] = {'source': semantic['source'],
                'dialogue': [{'role': m['role'], 'content': m['content']} for m in semantic.get('dialogueContext', [])],
                'priorCount': len(semantic.get('prior', []))}
        inputs.append(item)

(output / 'model-results.json').write_text(json.dumps(summaries, ensure_ascii=False, indent=2) + '\n')
(output / 'model-input-summary.json').write_text(json.dumps(inputs, ensure_ascii=False, indent=2) + '\n')
with (output / 'model-calls.csv').open('w') as file:
    writer = csv.DictWriter(file, fieldnames=list(rows[0]), lineterminator='\n'); writer.writeheader(); writer.writerows(rows)
