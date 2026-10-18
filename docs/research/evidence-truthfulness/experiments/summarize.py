"""Publish synthetic summaries only; raw model inputs and credentials stay local.
Answer grades are explicit manual annotations tied to exact answer digests.
"""
import collections,csv,hashlib,json,statistics,sys
from pathlib import Path
root,out=map(Path,sys.argv[1:3]);out.mkdir(parents=True,exist_ok=True)
annotations=json.loads((Path(__file__).parent/'answer-annotations.json').read_text());grades={r['id']:r for r in annotations['rows']}
def digest(x):return hashlib.sha256(json.dumps(x,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
def latency(values):
 s=sorted(values);return {'n':len(s),'p50':s[len(s)//2] if s else None,'p95':s[min(len(s)-1,int(len(s)*.95))] if s else None}
report={'schema':'memory.support-quality.v1','annotationMethod':annotations['method'],'studies':[]};calls=[]
for name in ['support-model','support-final']:
 r=json.loads((root/(name+'.json')).read_text());cases=[]
 fixture=json.loads((Path(__file__).parent/('ground-truth-final.json' if name=='support-final' else 'ground-truth.json')).read_text());facts={f['id']:f['text'] for f in fixture['facts']}
 for c in r['cases']:
  safe={k:v for k,v in c.items() if k!='cases'};safe['groups']=[]
  for g in c['cases']:
   row=dict(g)
   assessment=g.get('assessment') or {};citations=[v for n in assessment.get('needs',[]) for v in n.get('citations',[])]
   sourceClaims={}
   for call in r['calls']:
    if call['ordinal'] in g.get('callOrdinals',[]) and call['phase']=='SUPPORT': sourceClaims.update({x['id']:x['text'] for x in json.loads(call['messages'][-1]['content'])['claims']})
   row['citationGroundTruthMatch']=bool(citations) and all(sourceClaims.get(v['id']) in [facts[k] for k in c['evidenceKeys']] for v in citations)
   if name=='support-final':
    value=str(g.get('answer',g.get('disposition',g.get('error'))));assert hashlib.sha256(value.encode()).hexdigest()==grades[c['id']]['answerDigests'][g['mode']]
    row['manualAnswerOutcome']=grades[c['id']][g['mode']]
   safe['groups'].append(row)
  cases.append(safe)
 for call in r['calls']:
  u=call.get('usage') or {};calls.append({'study':name,'ordinal':call['ordinal'],'model':call['model'],'phase':call['phase'],'inputDigest':digest(call['messages']),'inputTokens':u.get('prompt_tokens'),'outputTokens':u.get('completion_tokens'),'cachedTokens':(u.get('prompt_tokens_details') or {}).get('cached_tokens',0),'providerEstimatedCostUSD':u.get('estimated_cost'),'elapsedMs':call['elapsedMs'],'httpStatus':call['status']})
 positive=[c for c in cases if c['expected']!='INSUFFICIENT'];negative=[c for c in cases if c['expected']=='INSUFFICIENT'];accepted=lambda c:c['groups'][1]['assessment']['needs'][0]['verdict'] in ['SUPPORTED','CONTRADICTED']
 tp=sum(accepted(c) and c['groups'][1]['citationGroundTruthMatch'] and c['groups'][1]['assessment']['needs'][0]['verdict']==c['expected'] for c in positive);fp=sum(accepted(c) for c in cases)-tp
 summary={'offeredRelevantEvidence':sum(len(set(c['evidenceKeys']) & set(c['authorizedCurrentKeys'])) for c in cases),'offeredCurrentCandidates':sum(len(c['authorizedCurrentKeys']) for c in cases),'knownEvidenceCoverageBeforeAssessment':f'{sum(set(c["evidenceKeys"]) <= set(c["authorizedCurrentKeys"]) for c in positive)}/{len(positive)}','note':'Fixed adversarial candidate sets, not ANN recall. State/citation constraints are deterministic; semantic classification is a real model result. A rejected supported demand counts as a miss.', 'trueSupportedOrRefutedAccepted':tp,'positiveGroundTruth':len(positive),'wrongUnsupportedAccepted':fp,'unsupportedGroundTruth':len(negative),'supportPrecision':tp/(tp+fp) if tp+fp else None,'falseRejectionRate':(len(positive)-tp)/len(positive),'strictVerdictMatches':sum(c['expected']==c['groups'][1]['assessment']['needs'][0]['verdict'] for c in cases)}
 if name=='support-final':
  summary['answerOutcomes']={mode:dict(collections.Counter(c['groups'][i]['manualAnswerOutcome'] for c in cases)) for i,mode in enumerate(['baseline','revised'])}
  summary['completeAnswerCorrectness']={mode:sum(c['groups'][i]['manualAnswerOutcome'] in ['SUPPORTED_ANSWER','CALIBRATED_ABSTENTION'] for c in cases) for i,mode in enumerate(['baseline','revised'])}
  summary['positiveAnswerAttributionConditional']={mode:{'correct':sum(c['groups'][i]['manualAnswerOutcome']=='SUPPORTED_ANSWER' for c in positive),'answered':sum(c['groups'][i]['manualAnswerOutcome'] in ['SUPPORTED_ANSWER','ATTRIBUTION_ERROR','UNSUPPORTED_ANSWER'] for c in positive),'falseAbstentions':sum(c['groups'][i]['manualAnswerOutcome']=='FALSE_ABSTENTION' for c in positive)} for i,mode in enumerate(['baseline','revised'])}
  summary['positiveAnswerAttributionConditional']['note']='Known-answer subset only. Conditional denominators differ; not an unconditional accuracy claim.'
 report['studies'].append({k:r.get(k) for k in ['schema','kind','sha','dirty','fixtureDigest','baselineReplay','totalCalls','knownProviderEstimatedCostUSD','callsWithoutCostReceipt']}|{'cases':cases,'metrics':summary,'assessorLatency':latency([c['groups'][1]['assessment']['elapsedMs'] for c in cases if c['groups'][1]['assessment']['model']])})
(out/'support-quality.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
# The normal Server cohort supplies end-to-end evidence, separate from the fixed candidate study.
r=json.loads((root/'runtime/result.json').read_text());wire=[];embeddings=[]
for f in sorted((root/'runtime').glob('wire-*-calls/call-*.json')):
 d=json.loads(f.read_text());i=d.get('effectiveInput') or {};response={};body=d.get('output','')
 try:response=json.loads(body)
 except ValueError:
  for line in body.splitlines():
   if line.startswith('data: {'):
    x=json.loads(line[6:])
    if x.get('usage'):response=x
 u=response.get('usage') or {};ms=i.get('messages',[]);first=str(ms[0].get('content','')) if ms else ''
 if d['url'].endswith('/embeddings'):
  embeddings.append({'model':i.get('model'),'dimensions':len(response.get('data',[{}])[0].get('embedding',[])),'usage':u,'elapsedMs':d.get('latencyMs'),'httpStatus':d.get('httpStatus')});continue
 phase='SUPPORT' if first.startswith('Evaluate whether each untrusted question') else 'PLAN' if first.startswith('Decompose the untrusted') else 'INGESTION' if 'Evaluate every source' in first else 'BODY' if 'The semantic gate has authorized RESPOND' in first else 'GATE_OR_REASONING'
 safe={'study':'runtime','ordinal':str(f.relative_to(root/'runtime')),'model':i.get('model'),'phase':phase,'inputDigest':digest(ms),'inputTokens':u.get('prompt_tokens'),'outputTokens':u.get('completion_tokens'),'cachedTokens':(u.get('prompt_tokens_details') or {}).get('cached_tokens',0),'providerEstimatedCostUSD':u.get('estimated_cost'),'elapsedMs':d.get('latencyMs'),'httpStatus':d.get('httpStatus')};calls.append(safe)
 wire.append(safe|{'lastQuestion':ms[-1].get('content') if ms else None,'hasL1':'[L1]' in json.dumps(ms,ensure_ascii=False),'hasEditor':'苔桥-4836' in json.dumps(ms,ensure_ascii=False),'hasTea':'木槿-9275' in json.dumps(ms,ensure_ascii=False),'hasCupOrder':'溪石-315' in json.dumps(ms,ensure_ascii=False)})
turns=[{k:t.get(k) for k in ['ordinal','input','person','shortContextCleared','ingestion','implementation','elapsedMs']}|{'answer':t.get('response',{}).get('reply')} for t in r['turns']]
publicRuntime={k:r.get(k) for k in ['sha','models','embeddingModel','personaVersion','temperature','maxTokens','status','usage','executionSegments','authorityState','projection','relations']};publicRuntime.update({'schema':'memory.support-runtime.v1','turns':turns,'retrievalEvidence':r['retrievalEvidence'],'wire':wire,'embeddingCalls':embeddings,'note':'All questions run via actual Server, Host grant, Character, Journal and PostgreSQL. Before every QA, formal L1 expiration + isolated restart + new session. Operator only provisions synthetic grants; ordinary messages use grants. No product Desktop/QQ credential claim. Failed no-planner ordinals 5/6 remain; ordinal7 changes only implementation/derived assessment protocol, not facts.'})
(out/'runtime.json').write_text(json.dumps(publicRuntime,ensure_ascii=False,indent=2))
for name in ['integration','integration-final','integration-measured','scale']:
 (out/(name+'.json')).write_text(json.dumps(json.loads((root/(name+'.json')).read_text()),ensure_ascii=False,indent=2))
stack=json.loads((root/'stack.json').read_text());ancestry=json.loads((root/'ancestry.json').read_text());(out/'stack.json').write_text(json.dumps({'schema':'yuvi.stack-snapshot.v1','prs':stack,'ancestry':ancestry,'note':'Historical SHA-specific CI snapshots, not release approval; latest feature HEAD must pass its own CI.'},ensure_ascii=False,indent=2))
formation=[]
for table in json.loads((root/'formation-ledgers.json').read_text()):
 rows=table['rows'];kept=[]
 for row in rows:
  text=json.dumps(row,ensure_ascii=False)
  if table['table']=='memory_semantic_jobs' and (':reassessment:' in row['job_id'] or ('已经无效' in text and '4A87' in text)):
   kept.append({k:row.get(k) for k in ['job_id','status','result','error_code','attempts','provider_model','token_usage','input_context']})
  elif table['table']=='memory_decision_reassessments':kept.append(row)
  elif table['table']=='finalized_ingestion_turns' and row['status']=='partial':kept.append(row)
  elif table['table']=='finalized_ingestion_events' and 'accepted-user:' in row['finalized_turn_id'] and ('4A87' in text or '已经无效' in text):kept.append(row)
 if kept:formation.append({'group':table['group'],'table':table['table'],'rows':kept})
(out/'formation.json').write_text(json.dumps({'schema':'memory.sibling-correction-diagnosis.v1','sources':'Prior synthetic #331 cohorts, read-only diagnosis. No real Alice data.','tables':formation},ensure_ascii=False,indent=2))
with (out/'model-calls.csv').open('w') as f:
 w=csv.DictWriter(f,fieldnames=list(calls[0]));w.writeheader();w.writerows(calls)
usage={'calls':len(calls),'inputTokens':sum(c.get('inputTokens') or 0 for c in calls),'outputTokens':sum(c.get('outputTokens') or 0 for c in calls),'cachedTokens':sum(c.get('cachedTokens') or 0 for c in calls),'knownProviderEstimatedCostUSD':sum(c.get('providerEstimatedCostUSD') or 0 for c in calls),'unknownCostCalls':sum(c.get('providerEstimatedCostUSD') is None for c in calls),'embeddingCalls':len(embeddings),'embeddingCostReceipts':sum(isinstance(e['usage'].get('estimated_cost'),(int,float)) for e in embeddings),'embeddingUsage':[e['usage'] for e in embeddings],'phases':dict(collections.Counter(c['phase'] for c in calls)),'supportCallLatency':latency([c['elapsedMs'] for c in calls if c['phase']=='SUPPORT']),'notes':'No new Vision calls. Provider estimates, not invoice. Support runs capped110 requests/$0.10 each; Runtime60/$0.10. Reused baseline answers are not counted as new calls.'}
(out/'usage.json').write_text(json.dumps(usage,ensure_ascii=False,indent=2))
