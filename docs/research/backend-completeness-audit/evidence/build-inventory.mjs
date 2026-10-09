import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { classify, POLICY_VERSION } from './inventory-policy.mjs';
const here = dirname(new URL(import.meta.url).pathname);
const repo = resolve(process.argv[2] ?? '/workspace/YUVI-source');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 }).toString();
const sha = git('rev-parse', process.argv[4] ?? 'HEAD').trim();
const output = process.argv[3] ? resolve(process.argv[3]) : here;
const tree = git('ls-tree', '-r', '-z', sha).split('\0').filter(Boolean).map(row => {
  const [meta,p] = row.split('\t'); const [mode,type,blob] = meta.split(' '); return { path:p,mode,type,blob };
});
const data = new Map();
for (const f of tree) {
  if (f.type !== 'blob') { data.set(f.path, ''); continue; }
  const body = execFileSync('git',['-C',repo,'cat-file','blob',f.blob],{maxBuffer:64*1024*1024});
  data.set(f.path,body.toString('utf8'));
}
const manifests = tree.filter(f => /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|requirements\.txt)$/.test(f.path)).map(f => f.path);
function owner(p) {
  const dirs = manifests.filter(m => p.startsWith(dirname(m) + '/') || dirname(m)==='.').sort((a,b)=>dirname(b).length-dirname(a).length);
  const m = dirs[0];
  if (m && dirname(m)!=='.') {
    let name = dirname(m);
    if (m.endsWith('package.json')) { try {name=JSON.parse(data.get(m)).name ?? name;} catch {} }
    return { package:name,manifest:m };
  }
  return {package:p.includes('/')?p.split('/')[0]:'repository-root',manifest:m ?? null};
}
const files = tree.map(f => {
  const body = data.get(f.path); const c = classify(f.path,body.slice(0,8192)); const o=owner(f.path);
  let process='UNKNOWN', participation='UNKNOWN', basis=[];
  if (f.path.startsWith('apps/desktop/src-tauri/')) {process='TAURI_NATIVE_HOST';participation='CONDITIONAL';basis.push({kind:'CARGO_MEMBER',manifest:'apps/desktop/src-tauri/Cargo.toml',condition:'cfg/platform/runtime module linkage not yet verified'});}
  else if (f.path.startsWith('apps/server/')) process='SERVER_NODE';
  else if (f.path.startsWith('apps/web/')) process='WEBVIEW_OR_BROWSER';
  else if (f.path.startsWith('services/')) process=f.path.split('/').slice(0,2).join('/');
  else if (f.path.startsWith('scripts/')) process='BUILD_OR_OPERATOR_PROCESS';
  else if (f.path.startsWith('packages/')) process='LIBRARY_HOST_UNRESOLVED';
  else if (f.path.startsWith('.github/') || f.path.startsWith('infra/')) process='BUILD_OR_DEPLOYMENT';
  else process='REPOSITORY_BUILD_INPUT';
  if (o.manifest) basis.push({kind:'NEAREST_MANIFEST',manifest:o.manifest,notProofOfReachability:true});
  if (!c.production) participation=c.category==='VENDOR'?'CONDITIONAL':'NOT_PRODUCTION_BY_CLASSIFICATION';
  if (c.category==='MIGRATION') {process='DATABASE_MIGRATOR';participation='CONDITIONAL';basis.push({kind:'MIGRATION_SOURCE',condition:'migration discovery and schema version require trace'});}
  return {gitPath:f.path,commitSHA:sha,blobSHA:f.blob,gitMode:f.mode,...c,...o,
    participatesCurrentProductionBuild:participation,buildImportRegistrationBasis:basis,processOrHost:process,
    initialResponsibilities:c.production?['UNRESOLVED']:[],structuralAnalysisCompleted:false,structuralAnalysisMethod:null,
    requiresDeepReading:c.production,deepReadingCompleted:false,deepReadingEvidence:[],discoveredCallBoundaries:[],
    unresolvedQuestions:c.production?['Production membership, consumers and semantic transformations not yet reviewed']:[],
    excludedFromFirstPartyAudit:!c.production,exclusionReason:!c.production?c.classificationReason:null};
});
const inv={schemaVersion:'yuvi-source-inventory.v1',baselineSHA:sha,policyVersion:POLICY_VERSION,
  policySHA256:createHash('sha256').update(readFileSync(join(here,'inventory-policy.mjs'))).digest('hex'),
  universe:'Every git ls-tree tracked entry at pinned main, before finding-specific investigation',
  generatedAt:new Date().toISOString(),files};
writeFileSync(join(output,'source-inventory.json'),JSON.stringify(inv,null,2)+'\n');
console.log(JSON.stringify({baselineSHA:sha,tracked:files.length,productionCandidates:files.filter(f=>f.production).length,
  unclassified:files.filter(f=>f.category==='UNKNOWN').map(f=>f.gitPath),categories:Object.fromEntries([...new Set(files.map(f=>f.category))].map(c=>[c,files.filter(f=>f.category===c).length]))},null,2));
