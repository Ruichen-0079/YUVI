import {execFileSync} from 'node:child_process';
import {dirname,resolve,join} from 'node:path';
import {writeFileSync,readFileSync} from 'node:fs';
import {classify} from './inventory-policy.mjs';
const here=dirname(new URL(import.meta.url).pathname),repo=resolve(process.argv[2]);
const git=(...a)=>execFileSync('git',['-C',repo,...a],{maxBuffer:32*1024*1024}).toString();
const main=git('rev-parse','origin/main').trim();
const openPRs=JSON.parse(readFileSync(join(here,'open-pull-requests.json'),'utf8'));
const rows=git('for-each-ref','--format=%(refname:short)|%(objectname)|%(committerdate:iso-strict)','refs/remotes/origin').trim().split('\n').map(r=>r.split('|'));
const branches=rows.map(([name,sha,date])=>{
  const changes=git('diff','--name-status',main,sha).trim().split('\n').filter(Boolean).map(row=>{const [status,...paths]=row.split('\t');return {status,path:paths.at(-1),classification:classify(paths.at(-1))};});
  const added=changes.filter(c=>c.status==='A'&&c.classification.production);
  const prod=changes.filter(c=>c.classification.production);
  const prs=openPRs.filter(p=>'origin/'+p.headRefName===name);
  return {branch:name,commitSHA:sha,commitDate:date,openPRs:prs.map(p=>p.number),productionDifferencesFromMain:prod.map(c=>({path:c.path,status:c.status})),newProductionPaths:added.map(c=>c.path),
    activityEvidence:name==='origin/main'?'CURRENT_MAIN':prs.length?'OPEN_PR':date>='2026-09-23'?'RECENT_HEAD_NO_OPEN_PR':'HISTORICAL_HEAD_ACTIVITY_UNCONFIRMED',
    auditDisposition:name==='origin/main'?'MAIN_BASELINE':added.some(c=>c.path.includes('/plunge/'))?'INDEPENDENT_PRODUCT_FORK_LOCKED':added.length?'OTHER_INDEPENDENT_PATHS_UNRESOLVED':'NO_NEW_PATHS_BUT_FUNCTION_DIFFS_NOT_EXHAUSTIVELY_REVIEWED',
    deploymentSHAConfirmed:false};
});
writeFileSync(join(here,'build-and-branch-matrix.json'),JSON.stringify({baselineSHA:main,branchEnumeration:'Every fetched refs/remotes/origin head; actual two-tree code/path differences, not branch-name inference',
  activityLimitation:'Commit recency and open PRs cannot prove operator deployment or active maintenance; unexplained old heads remain explicit unknown',branches,
  mainBuilds:[{host:'server',entry:'apps/server/src/index.ts',basis:'apps/server/package.json + boot assembly'},{host:'web',entry:'apps/web/src/main.tsx',basis:'Vite index.html + apps/web/package.json'},{host:'desktop',entry:'apps/desktop/src-tauri/src/main.rs',basis:'Cargo + Tauri conf/build hooks'},{host:'Mem0',entry:'services/memory-mem0/src/yuvi_mem0/__main__.py',basis:'pyproject + PyInstaller spec + supervisor'},{host:'STT',entry:'services/local-stt/server.py',basis:'packaging spec + local service supervisor'},{host:'dots-TTS',entry:'services/dots-tts/server.py',basis:'explicit operator sidecar; packaging not assumed'}]},null,2)+'\n');
console.log(JSON.stringify({remoteHeads:branches.length,independentProductForks:branches.filter(b=>b.auditDisposition==='INDEPENDENT_PRODUCT_FORK_LOCKED').map(b=>b.branch),otherIndependentCandidates:branches.filter(b=>b.auditDisposition==='OTHER_INDEPENDENT_PATHS_UNRESOLVED').map(b=>b.branch)}));
