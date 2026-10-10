#!/usr/bin/env python3
"""Reuse pinned compiler graphs. No new repository-wide syntax scan."""
import json, gzip, pathlib, hashlib, subprocess, collections, random, sys
HERE=pathlib.Path(__file__).resolve().parent
ROOT=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else HERE.parents[3]
OLD=ROOT/'docs/research/backend-completeness-audit/evidence'
BASE='0d894cc70d42ebba0df132924f5ea181c062b431'
def read(n): return json.loads((OLD/n).read_text())
def write(n,v): (HERE/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT,text=True).strip()
def key(x):return (x.get('path'),x.get('line'),x.get('callee'))
def stable(x):return 'boundary:'+hashlib.sha256(json.dumps(x,sort_keys=True).encode()).hexdigest()[:18]
a=read('entrypoint-traces.json')['entries'];b=read('producer-consumer-graph.json')['states'];c=read('data-transformation-boundaries.json')['candidates'];g=read('cross-pass-discrepancies.json')['discrepancies'];inv=read('source-inventory.json')['files']
raw=json.loads(gzip.decompress((OLD/'typescript-relations.json.gz').read_bytes()))
other=json.loads(gzip.decompress((OLD/'other-language-relations.json.gz').read_bytes()))
byC=collections.defaultdict(list);byA=collections.defaultdict(list)
for x in c:byC[key(x)].append(x['id'])
for x in a:byA[key(x)].append(x['id'])
wires={x['target']['path']:x['target']['name'] for x in raw['calls'] if x['path']=='apps/server/src/server.ts' and x['callee'].startswith('register') and x.get('target',{}).get('path','').startswith('apps/server/src/routes/')}
rows={};links=collections.defaultdict(set)
range_names=['EXTERNAL_ENTRY','MODEL_IO','PERSISTENT_STATE','AUTHORIZED_EFFECT','CROSS_PROCESS_PROVIDER','ASYNC_OWNERSHIP']
def add(call,categories,confirmed=False):
 ident=stable([call.get('path'),call.get('caller'),call.get('callee'),call.get('line')])
 if ident in rows: rows[ident]['categories']=sorted(set(rows[ident]['categories']+categories));return ident
 originals=byC[key(call)]+byA[key(call)]
 r={'id':ident,'sourceVersion':raw['baselineSHA'],'currentSourcePath':call['path'],'sourceLine':call.get('line'),'categories':categories,'boundaryClass':'CONFIRMED_REGISTRATION' if confirmed else 'RISK_CANDIDATE_REQUIRES_WIRING','originalCandidateIDs':originals,'producer':{'path':call['path'],'function':call.get('caller'),'expression':call.get('callee')},'consumer':call.get('target') or {'resolution':'UNRESOLVED'},'entryAndActivation':{'serverRegistration':wires.get(call['path']),'literalRoute':next((z.get('value') for z in call.get('arguments',[]) if z.get('kind')=='STRING'),None),'condition':'Registered in buildServer; host/config conditions still require per-handler review' if confirmed else 'Static call only; runtime activation or dynamic dependency unresolved'},'structures':{'input':call.get('arguments',[]),'output':call.get('outputType')},'risk':'Capacity, scope, error fidelity or asynchronous ownership require semantic verification; syntax alone does not prove loss','allowedDomainAndUnits':'OPEN: static signature is not an allowed-domain proof','failureAndCancellation':'OPEN: not inferred from return type','lifecycleOwner':'OPEN: not inferred from syntax','staticEvidence':[{'artifact':'typescript-relations.json.gz','path':call['path'],'line':call.get('line'),'resolution':call.get('resolution')}],'positiveTests':[],'negativeTests':[],'counterfactualTests':[],'uncoveredConditions':['Handler fields, runtime consumers and exceptional paths not individually verified'],'conclusion':'OPEN_WITH_REASON','reason':'Preserved derived risk candidate; this batch does not claim semantic verification'}
 rows[ident]=r
 for orig in originals:links[orig].add(ident)
 return ident
# Literal route registrations are actual registrations, not every callback or app call.
for call in raw['calls']:
 p=call['path'];s=call['callee'];categories=[]
 confirmed=p in wires and s in ['app.get','app.post','app.put','app.patch','app.delete','app.options'] and any(z.get('kind')=='STRING' for z in call.get('arguments',[])) and call.get('caller','').split('@')[0]==wires[p]
 if confirmed: categories.append('EXTERNAL_ENTRY')
 if any(t in s for t in ['generateReply','generateReasoning','streamReply','transcribe','synthesize','analyzeImage','embedText','buildChatInput','createCharacterChatInput','normalizeReasoningOutput']):categories.append('MODEL_IO')
 if any(t in s for t in ['.query','appendMessage','completeMessage','failMessage','rememberInteraction','storeCandidate','storeMemories','forgetMemories','deleteMemory','retrieveRelevantMemories','listRecentMessages','appendReplyComponent','appendJournal','commitReceipt','commitAdmission','writePrivateJson','writeManagedFile','writeFile','unlink','rename','createMemory','updateMemory','appendCorrection','fenceCorrection','reconcileCorrection']):categories.append('PERSISTENT_STATE')
 if any(t in s for t in ['callTool','readAuthorizedLocalText','dispatchOnce','admitIntent','requireLocalDashboardAccess','executeCapability','publishPublication','deliverOutwardEffect']):categories.append('AUTHORIZED_EFFECT')
 if any(t in s for t in ['fetch','generateReply','generateReasoning','streamReply','transcribe','synthesize','callTool','spawn','invokeSidecar']):categories.append('CROSS_PROCESS_PROVIDER')
 if any(t in s for t in ['.abort','.unsubscribe','.release','.close','.delete']) and any(t in p for t in ['routes/','effect','worker','provider','supervisor','media','stream','runtime-orchestrator']):categories.append('ASYNC_OWNERSHIP')
 if categories:add(call,categories,confirmed)
# Non-TS platform/sidecar origins remain visible; none are automatically called live.
for x in other['entrypoints']:
 ident=stable(['other',x]);rows[ident]={'id':ident,'sourceVersion':raw['baselineSHA'],'currentSourcePath':x.get('path'),'categories':['EXTERNAL_ENTRY','CROSS_PROCESS_PROVIDER'],'boundaryClass':'PLATFORM_OR_SIDECAR_CANDIDATE','originalCandidateIDs':[x['id']] if 'id' in x else [],'producer':x,'consumer':{'resolution':'UNRESOLVED'},'entryAndActivation':'Platform cfg / sidecar launch / environment required; deployment unconfirmed','structures':'See previous native/Python syntax graph; no TS-version splicing','risk':'Cross-process capacity, identity and cancellation unresolved','allowedDomainAndUnits':'OPEN','failureAndCancellation':'OPEN','lifecycleOwner':'OPEN','staticEvidence':['other-language-relations.json.gz'],'positiveTests':[],'negativeTests':[],'counterfactualTests':[],'uncoveredConditions':['Native/device/service runtime not executed in this batch'],'conclusion':'OPEN_WITH_REASON','reason':'Cannot infer live native or sidecar wiring from syntax alone'}
# Human review annotations add exact production contracts to automatically indexed paths.
reviews=json.loads((HERE/'reviewed-boundaries.json').read_text())
for v in reviews:
 matches=[r for r in rows.values() if r['currentSourcePath'] in v['paths'] and (not v.get('callees') or r.get('producer',{}).get('expression') in v['callees'])]
 # A reviewed boundary may be a newly added wrapper absent in the old graph. It is explicitly linked to old path candidates.
 originals=sorted(set(z['id'] for group in [a,b,c] for z in group if z.get('path') in v['paths']))
 ident=v['id'];r=dict(v);r.update(sourceVersion=git('rev-parse','HEAD'),currentSourcePath=v['paths'][0],boundaryClass='CONFIRMED_PRODUCTION_CHAIN',originalCandidateIDs=originals,derivedCallIDs=[x['id'] for x in matches],staticEvidence=v['staticEvidence'])
 rows[ident]=r
 for orig in originals:links[orig].add(ident)
 # Do not claim all operations in this file are verified: derived rows stay open.
# Every original ID stays traceable, even if it has no selected high-risk relation.
dis=[]
for route,group in [('A',a),('B',b),('C',c)]:
 for x in group:
  kind=x.get('kind','');classification=('TYPE_CONTRACT_NOT_RUNTIME_ALLOCATION' if route=='B' and kind in ['TypeAliasDeclaration','InterfaceDeclaration'] else 'LINKED_RISK_BOUNDARY' if links[x['id']] else 'SYNTAX_CANDIDATE_WIRING_UNRESOLVED')
  dis.append({'originalID':x['id'],'pass':route,'classification':classification,'boundaryIDs':sorted(links[x['id']]),'basis':('Type declaration is erased; semantic data contract retained, not excluded' if classification.startswith('TYPE_') else 'Pinned AST target/registration and explicit path review linkage; not proof of all branches'),'status':'OPEN_WITH_REASON' if not links[x['id']] else 'LINKED_NOT_AUTOMATICALLY_CLOSED'})
known={x['originalID'] for x in dis}
gaps=[]
for x in g:
 sources=x.get('sources',[x.get('source')]);sources=[y for y in sources if isinstance(y,str)]
 gaps.append({'originalID':x['id'],'kind':x['kind'],'path':x.get('path'),'originalRecord':x,'boundaryIDs':sorted({z for y in sources for z in links[y]}),'disposition':'PRESERVED_OPEN_GAP','reason':'Candidate disambiguation does not close old semantic gaps; no silent removal'})
sourcefiles=sorted({r['currentSourcePath'] for r in rows.values() if r.get('currentSourcePath')})
blobs={p:git('hash-object',p) for p in sourcefiles if (ROOT/p).is_file()}
inputs=['source-inventory.json','entrypoint-traces.json','producer-consumer-graph.json','data-transformation-boundaries.json','cross-pass-discrepancies.json','typescript-relations.json.gz','other-language-relations.json.gz','build-and-branch-matrix.json']
write('high-risk-boundary-ledger.json',{'schema':'yuvi-boundary-recovery.v1','baselineSHA':BASE,'graphSourceSHA':raw['baselineSHA'],'reviewedProductionSHA':git('rev-parse','HEAD'),'derivation':'Pinned compiler calls + buildServer registration targets + prior native graph + explicit reviewed paths; automatic call rows are candidates, not invented runtime proof','inputDigests':{p:digest(OLD/p) for p in inputs},'sourceBlobs':blobs,'testBlobs':{f:git('hash-object',f) for f in sorted({f for r in reviews for f in r['positiveTests']+r['negativeTests']})},'enumerationLimitations':['Not alias-complete; provider polymorphism, Rust cfg, Python dynamic dispatch and external deployment remain unresolved','New production wrappers verified by targeted tests; old graph is a baseline, not a regenerated full repository graph','Register callback extraction is exact for top-level literal register functions; nested registrations/dynamic routes require separate review','Persistent query types are candidate operations, not an exhaustive table consumer proof'],'boundaries':list(rows.values())})
write('candidate-disambiguation.json',{'rawCounts':{'productionFiles':sum(bool(x['production']) for x in inv),'A':len(a),'B':len(b),'C':len(c),'gaps':len(g)},'records':dis,'gaps':gaps})
# Seeded stratified selection is recorded honestly as sampled, not automatically read.
reviewedpaths={p for v in reviews for p in v['paths']};rng=random.Random(3211010);groups=collections.defaultdict(list)
for x in inv:
 if x['production'] and x['gitPath'] not in reviewedpaths:groups[x['package']].append(x['gitPath'])
samples=[]
for pkg,paths in sorted(groups.items()):
 for p in rng.sample(sorted(paths),min(1,len(paths))):samples.append({'package':pkg,'path':p,'review':'PENDING','reason':'Fixed seed residual production sample; no automatic deep-read claim'})
write('residual-sample.json',{'seed':3211010,'method':'One unreviewed production file per package, sorted populations; platform/config/script remain in population','samples':samples})
print(json.dumps({'boundaries':len(rows),'confirmedTopLevelServerRoutes':sum(r['boundaryClass']=='CONFIRMED_REGISTRATION' for r in rows.values()),'reviewedChains':len(reviews),'rawCounts':{'A':len(a),'B':len(b),'C':len(c),'gaps':len(g)},'sampleSize':len(samples)}))
