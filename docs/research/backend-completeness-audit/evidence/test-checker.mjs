/** Adversarial coverage-checker regression probes; production source never mutated. */
import {mkdtempSync,readFileSync,writeFileSync,symlinkSync,copyFileSync,readdirSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const here=dirname(new URL(import.meta.url).pathname),repo=resolve(process.argv[2]);const results=[];
function run(name,mutation,expected){
 const tmp=mkdtempSync(join(tmpdir(),'yuvi-checker-'));
 try{
  for(const n of readdirSync(here)){if(n.endsWith('.json')||n.endsWith('.gz')||['check-coverage.mjs','inventory-policy.mjs'].includes(n))symlinkSync(join(here,n),join(tmp,n));}
  if(mutation)mutation(tmp);
  const r=spawnSync(process.execPath,[join(tmp,'check-coverage.mjs'),'--repo',repo,'--no-write',...(name==='strict-incomplete'?['--require-complete']:[])],{encoding:'utf8'});
  // Node follows symlink script URL; use a real checker copy so mutated fixtures are in its own directory.
  if(r.status!==expected)throw Error(name+' status '+r.status+' expected '+expected+' '+r.stderr);
  results.push({name,expectedExit:expected,actualExit:r.status,stderr:r.stderr.trim(),stdout:JSON.parse(r.stdout||'null')});
 }finally{rmSync(tmp,{recursive:true,force:true});}
}
function replace(tmp,n,mut){const x=JSON.parse(readFileSync(join(here,n),'utf8'));mut(x);rmSync(join(tmp,n));writeFileSync(join(tmp,n),JSON.stringify(x));}
// Make the script a copy; symlinks for large raw indices avoid mutating originals.
const originalRun=run;
// Reusable mutation starts by converting checker/policy into actual copies.
const setup=(fn)=>(tmp)=>{for(const n of ['check-coverage.mjs','inventory-policy.mjs']){rmSync(join(tmp,n));copyFileSync(join(here,n),join(tmp,n));}fn?.(tmp);};
run('valid-partial',setup(),0);
run('strict-incomplete',setup(),2);
run('missing-production-record',setup(t=>replace(t,'source-inventory.json',x=>x.files.splice(x.files.findIndex(f=>f.production),1))),1);
run('wrong-baseline',setup(t=>replace(t,'source-inventory.json',x=>x.baselineSHA='0'.repeat(40))),1);
run('hidden-entry',setup(t=>replace(t,'entrypoint-traces.json',x=>x.entries.pop())),1);
run('invented-trace-symbol',setup(t=>replace(t,'manual-review.json',x=>x.traces[0].steps[0].symbolReferences[0].identifier='NONEXISTENT_RESEARCH_FUNCTION_999')),1);
run('hidden-boundary',setup(t=>replace(t,'data-transformation-boundaries.json',x=>x.candidates.pop())),1);
run('hidden-state',setup(t=>replace(t,'producer-consumer-graph.json',x=>x.states.splice(0,1))),1);
run('unsupported-unused',setup(t=>replace(t,'producer-consumer-graph.json',x=>x.states[0].consumerStatus='NO_PRODUCTION_CONSUMER')),1);
run('hidden-gap',setup(t=>replace(t,'cross-pass-discrepancies.json',x=>x.discrepancies.splice(x.discrepancies.findIndex(d=>d.kind==='STATE_CONSUMER_UNRESOLVED'),1))),1);
writeFileSync(join(here,'checker-regression-results.json'),JSON.stringify({baselineSHA:JSON.parse(readFileSync(join(here,'source-inventory.json'))).baselineSHA,results,scope:'Checks detect specific corruption and unsupported claims; cannot prove all omissions impossible'},null,2)+'\n');
console.log(JSON.stringify(results.map(({name,actualExit})=>({name,actualExit}))));
