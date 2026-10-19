import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const sources=new URL('../desktop-package/',import.meta.url);
test('sealed launcher refuses startup, foreign-boot and unsafe clearance; recovery review never starts services', {skip:process.platform!=='linux'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yuvi-recovery-launcher-'));
 try {
  const pkg=path.join(dir,'package'),state=path.join(dir,'state');fs.mkdirSync(pkg);fs.mkdirSync(state,{mode:0o700});fs.mkdirSync(path.join(pkg,'desktop'));
  for(const name of ['linux-launcher.mjs','linux-lifecycle.mjs','portable-state.mjs','provision-cubism-core.mjs'])fs.copyFileSync(new URL(name,sources),path.join(pkg,name));
  fs.writeFileSync(path.join(pkg,'desktop/yuvi-desktop'),'Unused; no production process can start in this fixture');
  fs.writeFileSync(path.join(pkg,'install-manifest.json'),JSON.stringify({schemaVersion:1,kind:'yuvi-linux-daily-packaged',platform:'linux-x64',version:'0.1.2',checkoutSha:'a'.repeat(40),profile:'r5'}));
  const gate=path.join(state,'recovery-required.json');fs.writeFileSync(gate,JSON.stringify({schema:'yuvi.cold-recovery-gate.v1',backupId:'test-point',checkoutSha:'a'.repeat(40)}));
  const run=(...args)=>spawnSync(process.execPath,[path.join(pkg,'linux-launcher.mjs'),...args],{encoding:'utf8',env:{...process.env,YUVI_PORTABLE_STATE_ROOT:state}});
  assert.match(run('start').stderr,/RECOVERY_REVIEW_REQUIRED/);
  const file=path.join(dir,'clearance.json');const clearance={schema:'yuvi.cold-recovery-clearance.v1',backupId:'test-point',checkoutSha:'a'.repeat(40),targetBootId:'foreign-boot',action:'SEALED_RESTORE',deletionReview:'NO_UNRECONCILED_DELETIONS',executionReview:'NO_POST_POINT_EFFECTS'};
  fs.writeFileSync(file,JSON.stringify(clearance),{mode:0o600});assert.notEqual(run('review-recovery',file).status,0);assert.ok(fs.existsSync(gate));
  clearance.targetBootId=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();fs.writeFileSync(file,JSON.stringify(clearance));fs.chmodSync(file,0o644);
  assert.match(run('review-recovery',file).stderr,/mode-0600/);fs.chmodSync(file,0o600);
  const link=path.join(dir,'link.json');fs.symlinkSync(file,link);assert.notEqual(run('review-recovery',link).status,0);
  const receipt=path.join(state,'recovery-review-test-point.json');fs.writeFileSync(receipt,'conflicting-review',{mode:0o600});assert.match(run('review-recovery',file).stderr,/Conflicting recovery/);assert.ok(fs.existsSync(gate));
  // Simulate death after fsync(receipt), before unlink(gate): the exact same review can finish.
  fs.writeFileSync(receipt,JSON.stringify(clearance));const reviewed=run('review-recovery',file);
  assert.equal(reviewed.status,0,reviewed.stderr);assert.match(reviewed.stdout,/No services started/);assert.equal(fs.existsSync(gate),false);assert.equal(fs.statSync(receipt).mode&0o777,0o600);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
