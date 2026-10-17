"""Export only synthetic answers and input/usage summaries; never credentials or image bytes."""
import csv, hashlib, json, sys
from pathlib import Path
source, target = map(Path, sys.argv[1:3])
target.mkdir(parents=True, exist_ok=True)
r = json.loads((source / 'result.json').read_text())
calls = []
vision = []
for f in sorted(source.glob('*-calls/call-*.json')):
    d = json.loads(f.read_text())
    i = d['effectiveInput']
    if not isinstance(i, dict): continue
    output = d.get('output', '')
    try: o = json.loads(output)
    except ValueError:
        frames = [json.loads(line[6:]) for line in output.splitlines() if line.startswith('data: {')]
        o = next((frame for frame in reversed(frames) if frame.get('usage')), {})
    u = o.get('usage') or {}
    context = json.dumps(i.get('messages', []), ensure_ascii=False)
    item = {'file': str(f.relative_to(source)), 'model': i.get('model'), 'stream': bool(i.get('stream')), 'httpStatus': d['httpStatus'],
        'inputDigest': hashlib.sha256(context.encode()).hexdigest(), 'inputBytes': len(context.encode()),
        'firstByteMs': d['firstByteMs'], 'latencyMs': d['latencyMs'],
        'inputTokens': u.get('prompt_tokens'), 'outputTokens': u.get('completion_tokens'),
        'cachedTokens': (u.get('prompt_tokens_details') or {}).get('cached_tokens', 0), 'estimatedCostUSD': u.get('estimated_cost'),
        'hasRetainedReport': 'BOUNDED_PROVIDER_REPORT' in context,
        'hasCardFooter': 'MAPLE-519C' in context, 'hasLongFinalCode': 'WILLOW-8E27' in context,
        'hasShapeEvidence': 'orange circle' in context or 'blue equilateral triangle' in context}
    calls.append(item)
    if str(i.get('model', '')).startswith('Qwen/'):
        vision.append({**item, 'actualProviderReport': o['choices'][0]['message']['content'], 'finishReason': o['choices'][0]['finish_reason']})
summary = {k:r[k] for k in ['schema','sha','dirty','models','visionModel','provider','personaVersion','temperature','maxTokens','usage','status']}
summary.update({'evidenceKind':'real-provider-normal-server-character-isolated-postgresql', 'observedAt':'2026-10-16',
    'initialHarnessFailure':'DELETE request erroneously sent JSON Content-Type without body; fixed and resumed same database without repeating successful samples.',
    'turns':[{'ordinal':t['ordinal'],'input':t['input'],'person':t['person'],'httpStatus':t['httpStatus'], 'elapsedMs':t['elapsedMs'], 'answer':t['response'].get('reply', ''),'ingestionStatus':t.get('ingestion',{}).get('status')} for t in r['turns']],
    'providerReports':vision,
    'finalObservationState':[{'id':o['observation_id'],'kind':o['kind'],'commitDigest':o['commit_digest'],'erased':bool(o['erased_at']),'hasPayload':o['evidence'] is not None} for o in r['observations']],
    'reportCommitStates':[e['evidence'].get('reportRetention') for e in r['effects'] if e['evidence'].get('reportRetention')],
    'qualityLimitation':'Only two synthetic images. Long OCR was summarized by the Provider, not a real >4000-character output overflow. Initial Chat response wrongly called A the shortest bar, despite correct relative heights in Vision report. No claimed universal visual accuracy or real-model reobservation of previously unextracted detail.'})
(target / 'vision-results.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
(target / 'vision-input-summary.json').write_text(json.dumps(calls,ensure_ascii=False,indent=2))
with (target / 'vision-calls.csv').open('w') as f:
    w = csv.DictWriter(f, fieldnames=list(calls[0]), lineterminator="\n"); w.writeheader(); w.writerows(calls)
