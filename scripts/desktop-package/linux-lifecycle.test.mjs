import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleBinding, classifyUnit, unifiedCgroup } from './linux-lifecycle.mjs';
const binding=lifecycleBinding('/package-a','/state-a','a'.repeat(40));
const unit={Id:binding.unit,Description:binding.description,LoadState:'loaded',Transient:'yes',Type:'exec',ExitType:'main',KillMode:'control-group',Restart:'no',ActiveState:'active',InvocationID:'b'.repeat(32),ControlGroup:'/user.slice/'+binding.unit,MainPID:'200'};
const self={pid:200,invocation:'b'.repeat(32),cgroup:unit.ControlGroup};
test('same state serializes different packages; distinct states never share a lifecycle unit',()=>{
 assert.equal(binding.unit,lifecycleBinding('/package-b','/state-a','c'.repeat(40)).unit);
 assert.notEqual(binding.unit,lifecycleBinding('/package-a','/state-b','a'.repeat(40)).unit);
 assert.equal(classifyUnit(unit,lifecycleBinding('/package-b','/state-a','c'.repeat(40)),self),'foreign');
});
test('only a matching OS invocation, cgroup and main process can enter managed startup',()=>{
 assert.equal(classifyUnit(unit,binding,self),'self');
 for (const override of [{pid:201},{invocation:'c'.repeat(32)},{cgroup:'/another/service'}]) assert.equal(classifyUnit(unit,binding,{...self,...override}),'running');
});
test('foreign units and unsafe kill/restart policy are never adopted',()=>{
 for (const override of [{Transient:'no'},{KillMode:'process'},{Restart:'always'},{ExitType:'cgroup'},{Description:'unrelated application'},{Id:'foreign.service'}]) assert.equal(classifyUnit({...unit,...override},binding,self),'foreign');
});
test('boot-stale files are not an authority; OS draining must complete before a new start',()=>{
 assert.equal(classifyUnit({...unit,ActiveState:'deactivating'},binding,self),'draining');
 assert.equal(classifyUnit({...unit,LoadState:'not-found'},binding,self),'absent');
 assert.equal(classifyUnit({...unit,ActiveState:'failed'},binding,self),'stopped');
 assert.equal(unifiedCgroup('0::/user.slice/test.service\n'),'/user.slice/test.service');
 assert.throws(()=>unifiedCgroup('1:cpu:/foreign'),/CGROUP_V2_REQUIRED/);
});
