"""Synthetic evidence only. Marker grading locates failure stages; it is not a
general NLP judge. All answers and negative samples remain reviewable."""
import csv,hashlib,json,re,sys,statistics
from pathlib import Path
from grading import responsibility_stage,shortest_label_contradiction,observation_stage
root,out=map(Path,sys.argv[1:3]);out.mkdir(exist_ok=True,parents=True)
markers={'interview':['周四','Thursday'],'location':['北塔三层'],'editor':['露川-4A87'],'tea':['月桂-5967'],'framework':['CedarTest-91'],'region':['FIN-42','Helsinki','赫尔辛基'],'owner':['林舟','Lin Zhou'],'diet':['花生','peanut'],'route':['eastern ridge','东部山脊','东脊']}
def has(text,key):return any(v.lower() in text.lower() for v in markers[key])
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
def needs(q):
 if 'Person' in q:return []
 if 'preferred tea' in q or '正在使用' in q:return ['interview','editor','tea']
 if 'test framework、' in q:return ['interview','tea','framework','region','owner']
 if '单元测试框架和' in q:return ['framework','region']
 if '面试地点、' in q:return ['location','diet','route']
 if '航空座位' in q:return ['editor','tea']
 return []
def calls_for(folder):
 result=[]
 for f in sorted(folder.glob('*-calls/call-*.json'),key=lambda p:(int(p.parent.name.split('-')[1]) if p.parent.name.startswith('wire-') else 0,int(p.stem.split('-')[-1]))):
  d=json.loads(f.read_text());i=d.get('effectiveInput') or {};ms=i.get('messages',[]);first=ms[0].get('content','') if ms else '';output=d.get('output','');response={}
  try:response=json.loads(output)
  except ValueError:
   for line in output.splitlines():
    if line.startswith('data: {'):
     frame=json.loads(line[6:]);
     if frame.get('usage'):response=frame
  u=response.get('usage') or {};is_chat=d['url'].endswith('/chat/completions');phase='EMBEDDING'
  if is_chat:
   phase='QUERY_PLAN' if str(first).startswith(('Transform the untrusted','Decompose the untrusted')) else 'INGESTION' if 'Evaluate every source' in str(first) else 'BODY' if 'The semantic gate has authorized RESPOND' in str(first) else 'GATE_OR_REASONING'
  text=json.dumps(ms,ensure_ascii=False)
  result.append({'file':str(f.relative_to(folder)),'model':i.get('model'),'phase':phase,'inputDigest':digest(ms if is_chat else i),'inputTokens':u.get('prompt_tokens'),'outputTokens':u.get('completion_tokens'),'cachedTokens':(u.get('prompt_tokens_details') or {}).get('cached_tokens',0),'estimatedCostUSD':u.get('estimated_cost'),'firstByteMs':d.get('firstByteMs'),'latencyMs':d.get('latencyMs'),'httpStatus':d.get('httpStatus'),'error':d.get('error',{}).get('name'),'lastQuestion':ms[-1].get('content') if ms else None,'hasL1':'[L1]' in text,'format':'DEMAND_QUOTED_CLAIMS' if 'quotedClaim' in text else 'FLAT','factPresence':{k:has(text,k) for k in markers}})
 return result
report={'schema':'memory.composition-quality.v1','method':'Source/authority/candidate/context/answer stages separated. Fixed markers and source IDs, manual fidelity notes; not a population accuracy estimate.','runtime':[]}
for name in ['runtime-baseline','runtime-revised','runtime-baseline-hybrid','runtime-revised-hybrid']:
 folder=root/name;r=json.loads((folder/'result.json').read_text());calls=calls_for(folder);bodies={}
 for c in calls:
  if c['phase']=='BODY':bodies.setdefault(c['lastQuestion'],[]).append(c)
 counters={};state={p['id']:p['state'] for p in r.get('projection',[])}
 group={k:r.get(k) for k in ['sha','models','embeddingModel','personaVersion','temperature','maxTokens','usage','status','executionSegments']};group['name']=name;group['turns']=[]
 for t in r['turns']:
  q=t['input'];index=counters.get(q,0);counters[q]=index+1;body=(bodies.get(q) or [])[index:index+1];body=body[0] if body else None
  if t.get('ingestion'):group['turns'].append({'ordinal':t['ordinal'],'source':q,'ingestion':t['ingestion'],'vectorIndexAfter':t.get('vectorIndexAfter')});continue
  runs=[x for x in r.get('retrievalEvidence',[]) if x['trace_id']==t['response'].get('traceId')];selected=[c for x in runs for c in x['candidates'] if c['selected']]
  fields=[]
  for key in (needs(q) if t['person']=='person-a' else []):
   records=[a for a in r.get('authorityState',[]) if has(a['event']['content'],key) and state.get(a['id']) in ['current','conflicted']];ids={a['id'] for a in records}
   channel={i for x in runs for c in (x.get('query_plan') or {}).get('channels',[]) for i in c['ids']}|{i for x in runs for c in (x.get('query_plan') or {}).get('vectorChannels',[]) for i in c['ids']}
   candidate={c['id'] for x in runs for c in x['candidates']};chosen={c['id'] for c in selected}
   in_context=bool(body and body['factPresence'][key]);answer=has(t['response'].get('reply',''),key)
   stage=responsibility_stage(formed=any(has(a['event']['content'],key) for a in r.get('authorityState',[])),current=bool(ids),authorized=True,channel=bool(ids&channel),candidate=bool(ids&candidate),selected=bool(ids&chosen),context=in_context,answer=answer)
   fields.append({'need':key,'currentIds':sorted(ids),'channelHit':bool(ids&channel),'candidateHit':bool(ids&candidate),'selected':bool(ids&chosen),'inActualBody':in_context,'answerHasValue':answer,'stage':stage})
  group['turns'].append({'ordinal':t['ordinal'],'query':q,'person':t['person'],'shortContextCleared':t.get('shortContextCleared'),'implementation':t.get('implementation'),'answer':t['response'].get('reply'),'elapsedMs':t['elapsedMs'],'fields':fields,'completeEvidence':bool(fields) and all(x['inActualBody'] for x in fields),'completeValueAnswer':bool(fields) and all(x['stage']=='CORRECT_VALUE' for x in fields),'body':body,'retrievals':[{'watermark':x['watermark'],'status':x['status'],'selected':[{'id':c['id'],'content':c['content'],'state':c['state']} for c in x['candidates'] if c['selected']],'queryPlan':x.get('query_plan')} for x in runs]})
  if t.get('person')=='person-b':group['turns'][-1]['privacyControl']={'selectedCount':len(selected),'anyPrivateValueInBody':bool(body and any(body['factPresence'].values())),'anyPrivateValueInAnswer':any(has(t['response'].get('reply',''),k) for k in markers)}
 group['authorityDigest']=digest(sorted((a['id'],a['event']['content'],state.get(a['id'])) for a in r.get('authorityState',[])))
 snapshots=[]
 for p in folder.glob('result-before-resume-*.json'):
  prior=json.loads(p.read_text())
  if prior.get('authorityState'):
   ps={x['id']:x['state'] for x in prior['projection']};snapshots.append({'file':p.name,'digest':digest(sorted((a['id'],a['event']['content'],ps.get(a['id'])) for a in prior['authorityState']))})
 group['priorAuthoritySnapshots']=snapshots
 with (out/(name+'-calls.csv')).open('w') as f:
  keys=['file','model','phase','inputDigest','inputTokens','outputTokens','cachedTokens','estimatedCostUSD','firstByteMs','latencyMs','httpStatus','error'];w=csv.DictWriter(f,fieldnames=keys,extrasaction='ignore',lineterminator='\n');w.writeheader();w.writerows(calls)
 report['runtime'].append(group)
report['manualFidelityNotes']=[
 {'group':'runtime-revised-hybrid','ordinal':15,'failure':'All five current claims entered the actual Body. The answer changed tea 月桂-5967 to 月桂-91. This is an answer grounding error, not retrieval failure.'},
 {'group':'runtime-revised-hybrid','ordinal':11,'failure':'Values recalled, but the first-person diet statement is phrased as Alice speaking about herself; subject attribution remains a grounding concern.'},
 {'group':'runtime-baseline','ordinal':9,'failure':'Correct date value but first English sentence says My interview rather than clearly attributing the user.'},
 {'group':'runtime-baseline/runtime-revised','failure':'Natural correction generated two propositions; one completed and another exhausted write retries, leaving PARTIAL. These runs are retained; a separate current-only cohort isolates retrieval. No Authority constraints were relaxed.'}
]
(out/'runtime-quality.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
matrix={'schema':'memory.frozen-matrix-summary.v1','groups':[]}
for name in ['baseline','revised-frozen','text-matrix-k5','real-vector-matrix','real-vector-matrix-reweighted','real-vector-matrix-final','unseen-text','unseen-vector']:
 r=json.loads((root/(name+'.json')).read_text());cases=[]
 for c in r['cases']:
  a=c.get('evidence') or {};plan=a.get('queryPlan') or {}
  cases.append({k:c[k] for k in ['id','split','mode','status','elapsedMs','needs','evidenceRecall','completeCoverage','precision','invalidLeaks','selected']}|{'queryPlan':plan})
 for c in cases:
  c['completeKnownEvidenceCoverage']=c.pop('completeCoverage')
  c['unknownNeedCount']=sum(n['unknown'] for n in c['needs'])
  cov=c['queryPlan'].get('coverage',[])
  c['unknownPreferredSlots']=sum(n['unknown'] and any(x.get('quote')==n['quote'] and x.get('preferredId') for x in cov) for n in c['needs'])
 matrix['groups'].append({'name':name,'sha':r['sha'],'fixtureDigest':r['fixtureDigest'],'resultLimit':r.get('resultLimit',8),'kind':r['kind'],'cases':cases,'vector':r.get('vector'),'embeddingCalls':r.get('embeddingCalls')})
(out/'frozen-matrix.json').write_text(json.dumps(matrix,ensure_ascii=False,indent=2))
grounding={'schema':'character.grounding-comparison.v1','kind':'real Chat/production Character replay of one frozen actual Qwen report; not a new Vision/Host execution experiment','groups':[]}
for name in ['baseline','revised']:
 r=json.loads((root/('grounding-'+name+'.json')).read_text());calls=calls_for(root) if False else [];cases=[]
 for c in r['cases']:
  text=c.get('answer','');contradiction=shortest_label_contradiction(text);cases.append({k:v for k,v in c.items() if k!='calls'}|{'labelValueContradiction':contradiction,'reportEnteredContext':all(any(r['observation'] in str(m.get('content','')) or json.dumps(r['observation'],ensure_ascii=False) in str(m.get('content','')) for m in call['messages']) for call in c['calls'])})
 for c in cases:
  unsupported='back of the card' in c['question']
  consistent=not c['labelValueContradiction'] and (not unsupported or bool(re.search(r"can't|cannot|not visible|isn't visible",c.get('answer',''),re.I)))
  c['diagnosticStage']=observation_stage(report_correct=True,entered_context=c['reportEnteredContext'],question_supported=not unsupported,answer_consistent=consistent)
 grounding['groups'].append({'name':name,'sha':r['sha'],'cases':cases})
(out/'grounding.json').write_text(json.dumps(grounding,ensure_ascii=False,indent=2))
