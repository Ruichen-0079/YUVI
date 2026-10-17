"""Synthetic GT only. Expected markers are grading data, never model inputs."""
import csv, hashlib, json, sys
from pathlib import Path
base, revised, out = map(Path,sys.argv[1:4]);out.mkdir(parents=True,exist_ok=True)
summary={'schema':'memory.retrieval-quality.v1','groups':[],'qualityBoundary':'Small discriminative samples, not independent population success rates. L1 was expired through the production RecentEpisodeStore API before marked memory-only questions. No Journal, Conversation or authoritative memory was erased.'}
for name,root in [('baseline-328',base),('revised',revised)]:
 r=json.loads((root/'result.json').read_text());calls=[]
 for f in sorted(root.glob('*-calls/call-*.json')):
  d=json.loads(f.read_text());i=d['effectiveInput'];messages=i.get('messages',[]);first=messages[0].get('content','') if messages else ''
  if not isinstance(first,str):continue
  o={}
  try:o=json.loads(d['output'])
  except ValueError:
   frames=[json.loads(line[6:]) for line in d['output'].splitlines() if line.startswith('data: {')];o=next((x for x in reversed(frames) if x.get('usage')), {})
  u=o.get('usage') or {};text=json.dumps(messages,ensure_ascii=False)
  phase='QUERY_PLAN' if first.startswith('Transform the untrusted user question') else 'SEMANTIC_INGESTION' if 'Evaluate every source' in first else 'BODY' if i.get('stream') else 'GATE_OR_REASONING'
  calls.append({'file':str(f.relative_to(root)),'model':i.get('model'),'phase':phase,'inputDigest':hashlib.sha256(text.encode()).hexdigest(),'inputBytes':len(text.encode()),'inputTokens':u.get('prompt_tokens'),'outputTokens':u.get('completion_tokens'),'cachedTokens':(u.get('prompt_tokens_details') or {}).get('cached_tokens',0),'estimatedCostUSD':u.get('estimated_cost'),'firstByteMs':d['firstByteMs'],'latencyMs':d['latencyMs'],'maxTokens':i.get('max_tokens'),'httpStatus':d['httpStatus'],'hasL1':'[L1]' in text,'hasOldEditor':'澄雨-a936d0' in text,'hasCurrentEditor':'露川-4A87' in text,'hasTea':'月桂-5967a1' in text,'hasFramework':'RIVER-BC91' in text})
 with (out/(name+'-calls.csv')).open('w') as f:
  w=csv.DictWriter(f,fieldnames=list(calls[0]),lineterminator='\n');w.writeheader();w.writerows(calls)
 (out/(name+'-input-summary.json')).write_text(json.dumps(calls,ensure_ascii=False,indent=2))
 group={k:r[k] for k in ['sha','dirty','models','provider','personaVersion','temperature','maxTokens','usage','status']};group['name']=name;group['turns']=[];group['sourceControlNote']='Initial SHA/dirty preserved. Revised final prefix replay ran committed production 4737bd6. Earlier development samples were not one frozen HEAD and are not a release success-rate estimate.'
 for t in r['turns']:
  trace=t['response'].get('traceId');runs=[x for x in r.get('retrievalEvidence',[]) if x['trace_id']==trace]
  group['turns'].append({'ordinal':t['ordinal'],'input':t['input'],'person':t['person'],'shortContextCleared':t.get('shortContextCleared',False),'httpStatus':t['httpStatus'],'elapsedMs':t['elapsedMs'],'answer':t['response'].get('reply',''),'ingestion':t.get('ingestion'),
   'retrievals':[{'status':x['status'],'watermark':x['watermark'],'candidates':x['candidates'],'queryPlan':x.get('query_plan')} for x in runs]})
 group['knowledge']=[{'id':k['id'],'content':k['event']['content'],'version':k['version'],'state':next((p['state'] for p in r['projection'] if p['id']==k['id']),None)} for k in r['authorityState']]
 group['relations']=r['relations']
 failure=[]
 for f in sorted(root.glob('*-calls/call-*.json')):
  d=json.loads(f.read_text());i=d['effectiveInput'];messages=i.get('messages',[])
  if not messages or 'Evaluate every source' not in str(messages[0].get('content','')):continue
  try:
   actual=json.loads(messages[-1]['content']);o=json.loads(d['output']);proposal=json.loads(o['choices'][0]['message']['content'])
   invalid=[p for p in proposal['propositions'] if p.get('evidenceText','') not in actual['source']]
   if invalid: failure.append({'file':str(f.relative_to(root)),'source':actual['source'],'invalidCitations':invalid,'finishReason':o['choices'][0]['finish_reason']})
  except (KeyError,ValueError,TypeError):pass
 group['semanticFailureEvidence']=failure
 summary['groups'].append(group)
summary['manualObjectiveAssessment']={
 'baselineMemoryOnlyCombined':{'ordinal':11,'expectedCurrentValues':['周四/Thursday','露川-4A87','月桂-5967a1'],'retrievalRecall': '1/3','answerFacts':'1/3'},
 'baselineMemoryOnlyEditor':{'ordinal':13,'expected':'露川-4A87','retrieved':False,'answered':False},
 'revisedCombined':[
 {'ordinal':4,'retrievedFacts':'2/3','answeredFacts':'2/3','failure':'Chinese plan ended with a single 茶; unigram absent from existing bigram index.'},
 {'ordinal':7,'retrievedFacts':'3/3','answeredFacts':'3/3'},
 {'ordinal':11,'retrievedFacts':'2/3','answeredFacts':'2/3','failure':'Plan used 喜欢的茶; bigrams did not overlap 茶叶偏好. Single-token Han prefix does not fix phrase segmentation.'}],
 'revisedEditor':{'ordinal':9,'retrieved':True,'answered':True},
 'revisedTeaOnly':{'ordinal':12,'retrieved':True,'answered':True},
 'isolation':'Both Person-B questions received no Person-A evidence or marker answers.',
 'EnglishSourceFailure':'Revised semantic extractor copied prior Chinese facts as citations for the English framework source. Admission rejected all three invalid citations; framework was not formed. The later unknown answer is not a retrieval failure. Baseline had formed a Chinese canonical framework fact, so this does not prove English-record/Chinese-query real-model quality.',
 'quote':'Hypothetical quoted editor change was skipped. Current editor remains 露川-4A87; old source is superseded, a separate current negative assertion about old invalidity may remain.',
 'gate':'Editor recovery and ranking improvements verified; broad cross-language/compound reliability and full R5 acceptance remain OPEN.'}
(out/'retrieval-model-results.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
