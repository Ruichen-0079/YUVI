"""Recheck frozen, pre-priority seed sampling; keep unread members explicitly pending."""
import collections,gzip,json,random
from pathlib import Path
p=Path(__file__).resolve().parent
old=json.loads(gzip.decompress((p/'initial-source-inventory.json.gz').read_bytes()));sample=json.loads((p/'omission-sampling.json').read_text());review=json.loads((p/'manual-review.json').read_text());current=json.loads((p/'source-inventory.json').read_text());idx=json.loads((p/'typescript-relations.json').read_text()) if (p/'typescript-relations.json').exists() else json.loads(gzip.decompress((p/'typescript-relations.json.gz').read_bytes()))
g=collections.defaultdict(list)
for f in old['files']:
 if f['production'] and f['category'] in ['FIRST_PARTY_SOURCE','MIGRATION']:g[f['package']].append(f['gitPath'])
r=random.Random(sample['seed']);selection=[{'package':k,'path':r.choice(sorted(v))} for k,v in sorted(g.items())]
assert selection==[{k:s[k] for k in ['package','path']} for s in sample['samples']], 'Frozen sample no longer reproduces'
for s in sample['samples']:
 logs=[x for x in review['files'] if x['path']==s['path']]
 s['reviewStatus']='FULL_FILE_DEEP_REVIEW' if any(x['level']=='FULL_FILE_DEEP_REVIEW' for x in logs) else 'TARGETED_ONLY_WHOLE_FILE_PENDING' if logs else 'UNREVIEWED_OPEN_GAP'
 s['reviewEvidence']=logs
sample['seedReproduced']=True;sample['selectionScript']='omission-review.py';sample['sampleFindings']=[
 {'id':'SAMPLE-PYTHON-ENTRY','path':'services/dots-tts/server.py','methodGap':'Initial Python scan found decorators only, omitted do_GET/do_POST/main; real HTTP server would have had missing A entries','response':'Global handler/main rule added, all Python reanalyzed; method-revisions METHOD-2','remaining':'Calls/handler protocol across processes still need manual tracing'},
 {'id':'SAMPLE-STATE-CAPACITY','path':'packages/cognition/src/capability-observation.ts','methodGap':'Standalone contract bound was locally correct; reverse consumer comparison reveals readText producer accepts larger input','response':'Trace whole chain and run 16000/16001/64000/cancel and information counterfactual probes'},
 {'id':'SAMPLE-PLATFORM','path':'apps/desktop/src-tauri/src/config/env_export.rs','methodGap':'TS-only audit would miss native mode/secret forwarding','response':'Rust all19 syntax units indexed; targeted env/host review; platform run and grammar gap kept OPEN'},
 {'id':'SAMPLE-DIAGNOSTIC','path':'apps/web/src/companion-embodied-behavior-diagnostics.ts','finding':'DEV-only bounded ledger has intentional management consumer, no false intelligence/UNUSED verdict'},
 {'id':'RISK-CLASSIFICATION','path':'scripts/check-host-environment-safety.node.mjs','methodGap':'Name-only test rule missed node:test and test-support directory','response':'Global classifier corrected; 8 records reclassified, not deleted; scope-revision and initial inventory retained'}]
incoming=collections.Counter(i['resolvedPath'] for i in idx['imports'] if i.get('resolvedPath'))
record={x['path']:x for x in idx['records']};risk=[]
for f in current['files']:
 if not f['production'] or f['category'] not in ['FIRST_PARTY_SOURCE','MIGRATION'] or f['deepReadingCompleted']:continue
 unit=record.get(f['gitPath'],{});calls=unit.get('calls',[]);writes=sum(any(word in c.get('callee','').lower() for word in ['append','persist','write','query','save','publish']) for c in calls)
 dynamic=sum(i.get('kind') in ['DYNAMIC_IMPORT','REQUIRE'] or i.get('resolution')=='UNRESOLVED' for i in unit.get('imports',[]))
 cross=f['language'] in ['Rust','Python','PowerShell','Batch','Shell'];low=incoming[f['gitPath']]==0
 score=min(writes,40)+dynamic*4+int(cross)*8+int(low)*5
 risk.append({'path':f['gitPath'],'package':f['package'],'score':score,'stateOrEffectCallCandidates':writes,'dynamicImportCandidates':dynamic,'noResolvedIncomingImports':low,'nonTSProcessOrPlatform':cross,'reviewStatus':'TARGETED_ONLY_WHOLE_FILE_PENDING' if f['deepReadingEvidence'] else 'UNREVIEWED_OPEN_GAP'})
sample['additionalRiskRule']='All nondeep executable/migration units: min(state/effect calls,40)+4*dynamic imports+8*non-TS/process+5*zero resolved incoming; sort descending score, then Git path. Syntax risk is not semantic complexity proof.'
sample['additionalRiskSamples']=sorted(risk,key=lambda x:(-x['score'],x['path']))[:16]
sample['unreviewedSamplesRemainExposed']=True
(p/'omission-sampling.json').write_text(json.dumps(sample,ensure_ascii=False,indent=2)+'\n');print({'seed':sample['seed'],'reproduced':True,'randomSamples':len(selection),'fullyRead':sum(s['reviewStatus']=='FULL_FILE_DEEP_REVIEW' for s in sample['samples']),'riskSamples':len(sample['additionalRiskSamples'])})
