/** Verify required artefacts, immutable pointers, relative report links and evidence digests. */
import {readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=dirname(new URL(import.meta.url).pathname),doc=dirname(here),repo=resolve(process.argv[2]);
const required=['source-inventory.json','check-coverage.mjs','entrypoint-traces.json','producer-consumer-graph.json','data-transformation-boundaries.json','cross-pass-discrepancies.json','build-and-branch-matrix.json','coverage-summary.json'];
for(const n of required)if(!existsSync(join(here,n)))throw Error('Missing mandatory artefact '+n);
const summary=JSON.parse(readFileSync(join(here,'coverage-summary.json'),'utf8'));const sha=summary.baselineSHA;
const manifest=JSON.parse(readFileSync(join(here,'artifact-manifest.json'),'utf8'));for(const f of [...manifest.files,...(manifest.experimentFiles??[])]){const p=join(here,f.path);if(!existsSync(p)||createHash('sha256').update(readFileSync(p)).digest('hex')!==f.sha256)throw Error('Evidence digest mismatch '+f.path);}
const links=[];for(const n of ['YUVI-Backend-Completeness-Audit.zh.md','README.zh.md']){const text=readFileSync(join(doc,n),'utf8');if(!text.includes(sha))throw Error('Missing baseline in '+n);
 for(const m of text.matchAll(/\]\(([^)]+)\)/g)){const target=m[1];if(/^https?:/.test(target)){const match=target.match(/\/blob\/([0-9a-f]{40})\/(.+?)(?:#L(\d+))?$/);if(match){const body=execFileSync('git',['-C',repo,'show',match[1]+':'+match[2]],{maxBuffer:32*1024*1024}).toString();if(match[3]&&Number(match[3])>body.split('\n').length)throw Error('Invalid source line '+target);}}else if(!existsSync(join(doc,target.split('#')[0])))throw Error('Broken report link '+target);links.push({document:n,target});}}
const dirty=execFileSync('git',['-C',repo,'diff','--name-only',sha,'--','apps','packages','services','scripts'],{encoding:'utf8'}).trim();if(dirty)throw Error('Production differences during audit '+dirty);
const out={baselineSHA:sha,mandatoryArtefacts:required.length,digestedEvidenceFiles:manifest.files.length,digestedExperimentFiles:(manifest.experimentFiles??[]).length,reportLinksChecked:links.length,productionImplementationDiff:[],limitedAuditComplete:summary.limitedAuditComplete,notAProofOfCorrectness:true};
writeFileSync(join(here,'delivery-verification.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
