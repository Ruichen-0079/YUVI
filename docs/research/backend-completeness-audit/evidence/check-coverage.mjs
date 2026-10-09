import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {classify} from './inventory-policy.mjs';
const here=dirname(new URL(import.meta.url).pathname),args=process.argv.slice(2);
const option=(n,d)=>{const i=args.indexOf(n);return i>=0?args[i+1]:d;};
const repo=resolve(option('--repo','/workspace/YUVI-source'));
const inventoryPath=resolve(option('--inventory',join(here,'source-inventory.json')));
const git=(...a)=>execFileSync('git',['-C',repo,...a],{maxBuffer:64*1024*1024}).toString();
const read=n=>JSON.parse(existsSync(join(here,n))?readFileSync(join(here,n),'utf8'):gunzipSync(readFileSync(join(here,n+'.gz'))).toString());
const inv=JSON.parse(readFileSync(inventoryPath,'utf8'));
const fail=m=>{console.error('COVERAGE_INVALID: '+m);process.exit(1);};
const sha=git('rev-parse','HEAD').trim();if(sha!==inv.baselineSHA)fail('HEAD differs from inventory baseline; checkout '+inv.baselineSHA+' explicitly');
const policyHash=createHash('sha256').update(readFileSync(join(here,'inventory-policy.mjs'))).digest('hex');
if(policyHash!==inv.policySHA256)fail('Classification policy hash changed; regenerate and review scope changes');
const tree=git('ls-tree','-r','-z',sha).split('\0').filter(Boolean).map(row=>{const [m,p]=row.split('\t');return {path:p,blob:m.split(' ')[2],type:m.split(' ')[1]};});
const map=new Map(inv.files.map(f=>[f.gitPath,f]));
if(map.size!==inv.files.length||map.size!==tree.length)fail('Missing, extra or duplicate tracked inventory record');
for(const f of tree){const r=map.get(f.path);if(!r||r.commitSHA!==sha||r.blobSHA!==f.blob)fail('Tracked path/SHA mismatch '+f.path);
 const body=f.type==='blob'?git('cat-file','blob',f.blob):'';const c=classify(f.path,body.slice(0,8192));
 for(const key of ['category','production','role','language','classificationReason'])if(r[key]!==c[key])fail('Classification differs from fixed policy '+f.path+' '+key);
 for(const key of ['package','participatesCurrentProductionBuild','buildImportRegistrationBasis','processOrHost','initialResponsibilities','structuralAnalysisCompleted','requiresDeepReading','deepReadingCompleted','discoveredCallBoundaries','unresolvedQuestions'])if(!(key in r))fail('Missing field '+key+' '+f.path);
 if(r.deepReadingCompleted&&!r.deepReadingEvidence?.some(e=>e.level==='FULL_FILE_DEEP_REVIEW'))fail('Unsupported deep completion '+f.path);
}
const dirty=git('diff','--name-only',sha,'--').trim().split('\n').filter(Boolean);for(const p of dirty)if(map.get(p)?.production)fail('Working production source differs from pinned Git blob '+p);
if(args.includes('--inventory-only')){console.log(JSON.stringify({baselineSHA:sha,tracked:tree.length,production:inv.files.filter(f=>f.production).length,classified:inv.files.filter(f=>f.production&&f.category!=='UNKNOWN').length,structuralCompleted:inv.files.filter(f=>f.production&&f.structuralAnalysisCompleted).length,excluded:inv.files.filter(f=>!f.production).length,scope:'Inventory integrity only; no branch consumer/transform/behavior completeness claim'}));process.exit(0);}
const TS=read('typescript-relations.json'),OTH=read('other-language-relations.json');
for(const index of [TS,OTH])if(index.baselineSHA!==sha)fail('Syntax index baseline differs');
const syntaxRecords=[...TS.records,...OTH.records];const syntaxPaths=new Set(syntaxRecords.map(r=>r.path));
if(syntaxPaths.size!==syntaxRecords.length)fail('Duplicate syntax/format unit');
for(const f of inv.files.filter(f=>f.production))if(!syntaxPaths.has(f.gitPath))fail('Missing production syntax/format unit '+f.gitPath);
for(const p of syntaxPaths)if(!map.get(p)?.production)fail('Syntax index outside current production policy '+p);
const production=inv.files.filter(f=>f.production),excluded=inv.files.filter(f=>!f.production),unclassified=inv.files.filter(f=>f.category==='UNKNOWN');
function group(key){const g={};for(const f of production){const n=f[key]??'UNKNOWN';const x=g[n]??={total:0,classified:0,structuralCompleted:0,deepCompleted:0,pendingDeep:0,buildUnconfirmed:0};x.total++;x.classified+=f.category!=='UNKNOWN'?1:0;x.structuralCompleted+=f.structuralAnalysisCompleted?1:0;x.deepCompleted+=f.deepReadingCompleted?1:0;x.pendingDeep+=f.requiresDeepReading&&!f.deepReadingCompleted?1:0;x.buildUnconfirmed+=f.participatesCurrentProductionBuild==='UNKNOWN'?1:0;}return g;}
const A=existsSync(join(here,'entrypoint-traces.json'))?read('entrypoint-traces.json'):null;
const B=existsSync(join(here,'producer-consumer-graph.json'))?read('producer-consumer-graph.json'):null;
const C=existsSync(join(here,'data-transformation-boundaries.json'))?read('data-transformation-boundaries.json'):null;
const D=existsSync(join(here,'cross-pass-discrepancies.json'))?read('cross-pass-discrepancies.json'):null;
for(const [name,p] of [['A',A],['B',B],['C',C],['D',D]])if(p&&p.baselineSHA!==sha)fail('Pass '+name+' baseline mismatch');
const reviews=existsSync(join(here,'manual-review.json'))?read('manual-review.json'):{files:[],traces:[],states:[],boundaries:[],gaps:[]};
const behavior=existsSync(join(here,'behavior-coverage.json'))?read('behavior-coverage.json'):null;
const branches=existsSync(join(here,'build-and-branch-matrix.json'))?read('build-and-branch-matrix.json'):null;
if(!A||!B||!C||!D)fail('Missing mandatory pass artefact');
const expectedA=[...TS.entrypoints.filter(e=>['HTTP_ROUTE_CANDIDATE','EVENT_OR_CALLBACK_CANDIDATE','REGISTRATION_CANDIDATE','TIMER_CANDIDATE'].includes(e.entryKind)),...OTH.entrypoints].map(x=>x.id).sort();
if(JSON.stringify(expectedA)!==JSON.stringify(A.entries.map(x=>x.id).sort()))fail('Pass A candidate entries were removed or altered');
for(const [name,items] of [['A',A.entries],['B',B.states],['C',C.candidates],['D',D.discrepancies]]){const ids=items.map(x=>x.id);if(ids.some(x=>!x)||new Set(ids).size!==ids.length)fail('Missing/duplicate IDs in pass '+name);}
const negativeCheckKinds=['directReferences','importsExports','constructionDI','interfaceDispatch','callbacks','eventSubscriptions','pluginRegistry','dynamicRoutesReflection','workersSchedulers','configurationConsumers','crossProcess'];
for(const state of [...B.states,...B.reviewedImportantStates])if(['UNUSED','NO_PRODUCTION_CONSUMER'].includes(state.consumerStatus)&&!negativeCheckKinds.every(k=>state.negativeConsumerChecks?.some(c=>c.kind===k&&c.status==='CHECKED_WITHIN_DECLARED_SCOPE'&&c.evidence?.length)))fail('Unsupported missing-consumer verdict '+state.id);
const declaredStateIDs=[...TS.typeDeclarations,...OTH.states].map(d=>d.id);for(const id of declaredStateIDs)if(!B.states.some(s=>s.id===id))fail('Missing B declaration record '+id);
for(const e of A.entries.filter(e=>e.reviewStatus==='STRUCTURE_ONLY'))if(!D.discrepancies.some(d=>d.id==='gap-entry:'+e.id))fail('Unrecorded A gap '+e.id);
for(const st of B.states.filter(st=>st.consumerStatus==='UNRESOLVED'))if(!D.discrepancies.some(d=>d.id==='gap-state:'+st.id))fail('Unrecorded B consumer gap '+st.id);
for(const t of reviews.traces){for(const p of t.entryPaths??[])if(!map.has(p))fail('Missing trace entry source '+p);for(const step of t.steps??[])if(!map.has(step.path))fail('Nonexistent trace step '+step.path);}
const expectedCalls=TS.calls.filter(c=>TS.entrypoints.some(e=>e.path===c.path&&e.line===c.line&&['MODEL_BOUNDARY_CANDIDATE','EXTERNAL_OR_STORAGE_CANDIDATE'].includes(e.entryKind))||/(^|\.)(adapt\w*|project\w*|normalize\w*|assemble\w*|to\w*(Record|Event|Input|Output|Observation)|create\w*(Observation|Evidence|Interpretation)|parse|safeParse)$/.test(c.callee));
const boundaryKey=b=>JSON.stringify([b.path,b.line,b.callee]);if(JSON.stringify(expectedCalls.map(boundaryKey))!==JSON.stringify(C.candidates.map(boundaryKey)))fail('Missing or altered C boundary candidate');
for(const b of C.candidates){const covered=reviews.boundaries.some(m=>m.evidence?.some(e=>e.path===b.path&&e.lineStart<=b.line&&e.lineEnd>=b.line));if(!covered&&!D.discrepancies.some(d=>d.id==='gap-boundary:'+b.id))fail('Unrecorded C field gap '+b.id);}
for(const t of reviews.traces)for(const step of t.steps??[]){if(!step.symbolReferences?.length)fail('Missing trace symbol validation '+t.id+' '+step.path);const body=git('cat-file','blob',map.get(step.path).blobSHA);for(const r of step.symbolReferences){if(!body.includes(r.identifier)||r.validation!=='IDENTIFIER_EXISTS_IN_PINNED_SOURCE_NOT_CALL_REACHABILITY_PROOF')fail('Nonexistent/unbounded trace symbol '+r.identifier);}}
for(const m of reviews.files){for(const e of m.evidence??[]){if(!map.has(e.path)||e.blobSHA!==map.get(e.path).blobSHA||e.commitSHA!==sha)fail('Manual evidence pointer SHA mismatch '+e.path);const count=git('cat-file','blob',map.get(e.path).blobSHA).split('\n').length;if(e.lineStart<1||e.lineEnd<e.lineStart||e.lineEnd>count)fail('Invalid reviewed line span '+e.path);}}
for(const b of reviews.boundaries)for(const key of ['function','inputStructure','outputStructure','preservedFields','discardedFields','addedInterpretations','conditions','downstreamConsumer'])if(!(key in b))fail('Missing reviewed field boundary '+b.id+' '+key);
const open=D?.discrepancies.filter(x=>x.status==='OPEN_GAP')??[];
const summary={schemaVersion:'yuvi-coverage-summary.v1',baselineSHA:sha,inventoryIntegrity:'VALID',scopeIsFinite:true,
 sourceCoverage:{trackedTotal:tree.length,productionTotal:production.length,classifiedTotal:production.filter(f=>f.category!=='UNKNOWN').length,unclassifiedTotal:unclassified.length,classificationCounts:Object.fromEntries([...new Set(inv.files.map(f=>f.category))].map(k=>[k,inv.files.filter(f=>f.category===k).length])),
 structuralCompleted:production.filter(f=>f.structuralAnalysisCompleted).length,structuralPending:production.filter(f=>!f.structuralAnalysisCompleted).map(f=>f.gitPath),deepCompleted:production.filter(f=>f.deepReadingCompleted).length,targetedReviewed:production.filter(f=>f.deepReadingEvidence.length).length,pendingDeep:production.filter(f=>f.requiresDeepReading&&!f.deepReadingCompleted).map(f=>f.gitPath),byPackage:group('package'),byLanguage:group('language'),byProcess:group('processOrHost')},
 entrypointCoverage:{identified:A?.entries.length??0,groupTraced:A?.entries.filter(e=>e.reviewStatus!=='STRUCTURE_ONLY').length??0,manualTraces:A?.traces.length??0,unhandled:A?.unresolved??['PASS_A_NOT_GENERATED']},
 stateCoverage:{identifiedCandidates:B?.states.length??0,manuallyReviewedImportantStates:B?.reviewedImportantStates.length??0,unresolvedConsumerOwnership:B?.states.filter(s=>s.consumerStatus==='UNRESOLVED').map(s=>s.id)??['PASS_B_NOT_GENERATED']},
 transformationCoverage:{identifiedCandidates:C?.candidates.length??0,reviewedImportantBoundaries:C?.reviewedBoundaries.length??0,highRiskUnanalyzed:D?.discrepancies.filter(d=>['BOUNDARY_FIELDS_NOT_REVIEWED','TRANSFORM_UNANCHORED_BY_ENTRY'].includes(d.kind)).map(d=>d.source)??['PASS_C_NOT_GENERATED']},
 crossPass:{total:D?.discrepancies.length??0,classified:D?.discrepancies.filter(d=>d.kind&&d.reason&&d.status).length??0,openGapCount:open.length,openGapIDs:open.map(d=>d.id)},
 dynamicAssemblyPending:reviews.gaps.filter(g=>/DYNAMIC|PLATFORM|BRANCH|PROCESS/.test(g.kind)),
 behaviorCoverage:behavior??{status:'NOT_YET_RECORDED'},realIntelligenceEffectEvidence:{actualModelQualityExperiments:0,status:'NO_M_EVIDENCE',needs:['Same-model input/control/output comparisons','Real deployed Alice SHA/configuration','Real media devices/remote providers','Long-run persistence/recovery and adaptation data']},
 branchCoverage:branches?{remoteHeads:branches.branches.length,independentProductForks:branches.branches.filter(b=>['INDEPENDENT_PRODUCT_FORK_LOCKED','INDEPENDENT_PRESENTATION_VARIANT_LOCKED'].includes(b.auditDisposition)).map(b=>({branch:b.branch,sha:b.commitSHA})),lockedIndependentVersions:branches.lockedIndependentVersions,activityUnknownHeads:branches.branches.filter(b=>b.activityEvidence==='HISTORICAL_HEAD_ACTIVITY_UNCONFIRMED').map(b=>b.branch)}:{status:'NOT_YET_GENERATED'},
 exclusions:excluded.map(f=>({path:f.gitPath,category:f.category,reason:f.exclusionReason,buildParticipation:f.participatesCurrentProductionBuild})),
 gates:{A:unclassified.length===0&&map.size===tree.length,B_ProducerConsumerRecordsExist:Boolean(B)&&B.states.every(s=>s.consumerStatus&&s.questions),B_ConsumerInvestigationComplete:Boolean(B)&&B.states.every(s=>s.consumerStatus!=='UNRESOLVED'),C_FieldTransformComplete:Boolean(C)&&C.candidates.every(b=>b.analysisStatus==='FIELDS_REVIEWED'),D_AllDiscrepanciesClassified:Boolean(D)&&D.discrepancies.every(d=>d.kind&&d.reason&&d.status),D_InvestigationComplete:Boolean(D)&&D.discrepancies.every(d=>d.status!=='OPEN_GAP'),importantOpenGapsRemain:open.length>0},
 limitedAuditComplete:false,interpretation:'Integrity/classification coverage is not correctness, runtime reachability, full deep review or model effectiveness. Important pending consumers/transforms/dynamic assembly prevent a completeness claim.'};
summary.limitedAuditComplete=summary.gates.A&&summary.gates.B_ConsumerInvestigationComplete&&summary.gates.C_FieldTransformComplete&&summary.gates.D_AllDiscrepanciesClassified&&!summary.gates.importantOpenGapsRemain;
if(!args.includes('--no-write'))writeFileSync(join(here,'coverage-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({baselineSHA:sha,tracked:tree.length,production:production.length,classified:summary.sourceCoverage.classifiedTotal,unclassified:unclassified.length,structuralCompleted:summary.sourceCoverage.structuralCompleted,deepCompleted:summary.sourceCoverage.deepCompleted,entrypoints:{identified:summary.entrypointCoverage.identified,groupTraced:summary.entrypointCoverage.groupTraced,manualTraces:summary.entrypointCoverage.manualTraces,unhandled:summary.entrypointCoverage.unhandled.length},states:{identified:summary.stateCoverage.identifiedCandidates,manuallyReviewed:summary.stateCoverage.manuallyReviewedImportantStates,unresolved:summary.stateCoverage.unresolvedConsumerOwnership.length},transformations:{identified:summary.transformationCoverage.identifiedCandidates,manuallyReviewed:summary.transformationCoverage.reviewedImportantBoundaries},openGaps:open.length,gates:summary.gates,limitedAuditComplete:summary.limitedAuditComplete},null,2));
if(args.includes('--require-complete')&&!summary.limitedAuditComplete)process.exitCode=2;
