"""Overlay syntax facts on independent Git inventories, never apply main manual judgements."""
from pathlib import Path
import json,subprocess,gzip
p=Path(__file__).resolve().parent;repo=__import__('sys').argv[1];main=json.load(open(p/'source-inventory.json'));matrix=json.load(open(p/'build-and-branch-matrix.json'));branchInfo=[]
def read(path):return json.loads(path.read_text()) if path.exists() else json.loads(gzip.decompress(Path(str(path)+'.gz').read_bytes()))
for name in ['plunge','desktop-presentation']:
 b=p/'branches'/name;inv=read(b/'source-inventory.json');ts=read(b/'typescript-relations.json');oth=read(b/'other-language-relations.json');by={r['path']:r for r in ts['records']+oth['records']}
 for f in inv['files']:
  if f['gitPath'] in by:
   r=by[f['gitPath']];f['structuralAnalysisCompleted']=not r['parseErrors'] if (r.get('parser') or '').startswith('TypeScript') else r['completed'];f['structuralAnalysisMethod']=r['parser'];f['discoveredCallBoundaries']=[{'id':e.get('id'),'line':e['line'],'kind':e.get('entryKind',e.get('kind'))} for e in r['entryCandidates']];f['unresolvedQuestions']=list(dict.fromkeys(f['unresolvedQuestions']+['Only independent branch syntax indexed; A/B/C manual investigation not completed in this round']))
 (b/'source-inventory.json').write_text(json.dumps(inv,ensure_ascii=False,indent=2)+'\n')
 info={'branch':name,'baselineSHA':inv['baselineSHA'],'tracked':len(inv['files']),'production':sum(f['production'] for f in inv['files']),'structuralCompleted':sum(f['production'] and f['structuralAnalysisCompleted'] for f in inv['files']),'deepCompleted':0,'actualAliceDeploymentConfirmed':False,'passA_B_C_ManualStatus':'OPEN_GAP','inventory':'branches/'+name+'/source-inventory.json','syntaxIndices':['branches/'+name+'/typescript-relations.json.gz','branches/'+name+'/other-language-relations.json.gz'],'limitations':'Whole independent version retained; source counts not added to main; old probes do not close every branch path'}
 if name=='plunge':info['assemblyEvidence']=[{'path':'apps/server/src/index.ts','lines':[39,62],'function':'composePlunge -> buildServer(surfacePlugins)','condition':'YUVI_PLUNGE_CONFIG_PATH and independent character composition; optional WebUI'}, {'path':'apps/server/src/server.ts','lines':[90,106],'function':'protectPlunge and combined surface source discovery','condition':'WebUI loopback independent Alice and token; host plugin source set'}, {'path':'apps/server/src/plunge/qq-composition.ts','lines':[96,140],'function':'new QQTransport -> transport.source()','condition':'Plunge runtime config/transport connection'}]
 else:info['independentDeltaBase']=subprocess.check_output(['git','-C',repo,'merge-base',main['baselineSHA'],inv['baselineSHA']],text=True).strip();info['uniqueDelta']=subprocess.check_output(['git','-C',repo,'diff','--name-status',info['independentDeltaBase'],inv['baselineSHA'],'--','apps','packages','services','scripts'],text=True).splitlines();info['finding']='Existing presentation/canvas/appearance modules differ without newly added production path; new-path-only branch screening would miss this variant.'
 (b/'branch-analysis.json').write_text(json.dumps(info,ensure_ascii=False,indent=2)+'\n');branchInfo.append(info)
 for row in matrix['branches']:
  if row['commitSHA']==inv['baselineSHA']:row['independentInventory']=info['inventory'];row['syntaxCoverage']=info['structuralCompleted'];row['firstPartyManualCoverage']='OPEN_GAP';row['actualMaintenanceActivity']='UNCONFIRMED';row['auditDisposition']='INDEPENDENT_PRODUCT_FORK_LOCKED' if name=='plunge' else 'INDEPENDENT_PRESENTATION_VARIANT_LOCKED'
matrix['lockedIndependentVersions']=branchInfo;matrix['noVersionMixing']=True
(p/'build-and-branch-matrix.json').write_text(json.dumps(matrix,ensure_ascii=False,indent=2)+'\n')
print([{k:i[k] for k in ['branch','baselineSHA','tracked','production','structuralCompleted']} for i in branchInfo])
