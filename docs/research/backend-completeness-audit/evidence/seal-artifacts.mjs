/** Hash frozen evidence and raw experiment files; excludes this self-referential manifest. */
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
const here=dirname(new URL(import.meta.url).pathname);
const sha=JSON.parse(readFileSync(join(here,'coverage-summary.json'),'utf8')).baselineSHA;
function scan(root){const found=[];function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){if(e.name==='__pycache__'||e.name.startsWith('.generated')||['artifact-manifest.json','delivery-verification.json','check-console.json','check-console.txt','probe-console.txt'].includes(e.name))continue;const p=join(dir,e.name);if(e.isDirectory())walk(p);else if(e.isFile()){const b=readFileSync(p);found.push({path:relative(here,p),bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});}}}walk(root);return found.sort((a,b)=>a.path.localeCompare(b.path,'en'));}
const output={baselineSHA:sha,files:scan(here),experimentFiles:scan(join(dirname(here),'experiments'))};
writeFileSync(join(here,'artifact-manifest.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({baselineSHA:sha,evidenceFiles:output.files.length,experimentFiles:output.experimentFiles.length}));
