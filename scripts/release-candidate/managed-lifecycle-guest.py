#!/usr/bin/env python3
"""Fault injection only in the synthetic yuvi-rc guest; actual managed release/WebView."""
import os,pathlib,json,subprocess,time,signal,runpy,threading,hashlib
BASE=pathlib.Path('/home/tester');STATE=BASE/'.local/share/YUVI/portable/0.1.2';OUT=BASE/'rc-evidence'
assert os.uname().nodename=='yuvi-rc' and os.getuid()==1000

def identity(pid):
 p=pathlib.Path('/proc')/str(pid);raw=(p/'stat').read_text().rsplit(') ',1)[1].split()
 return {'pid':pid,'uid':p.stat().st_uid,'startTicks':raw[19],'state':raw[0],
  'executable':str((p/'exe').readlink()),'cgroup':(p/'cgroup').read_text().strip()}
def managed():
 record=json.loads((STATE/'supervisor/lifecycle.json').read_text())
 env={**os.environ,'DBUS_SESSION_BUS_ADDRESS':'unix:path=/run/user/1000/bus'}
 text=subprocess.check_output(['systemctl','--user','show',record['unit'],'--property=InvocationID,MainPID,ActiveState,ControlGroup'],env=env,text=True)
 unit=dict(line.split('=',1) for line in text.strip().splitlines())
 assert unit['InvocationID']==record['invocationId'] and int(unit['MainPID'])==record['launcherPid']
 assert unit['ControlGroup']==record['controlGroup'] and record['bootId']==pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
 members=[]
 for x in (pathlib.Path('/sys/fs/cgroup')/record['controlGroup'].lstrip('/')/'cgroup.procs').read_text().split():
  try:members.append(identity(int(x)))
  except FileNotFoundError:pass # An observed short-lived worker exited; never substitute a reused PID.
 assert all(x['uid']==1000 and x['cgroup']=='0::'+record['controlGroup'] for x in members)
 return record,unit,members

def run(mode,native,api,scope,send,fill,script,wait):
 tools=runpy.run_path('/home/tester/guest-db.py');q=tools['sql'];lock=None
 if mode=='managed-correction':
  send('Please remember: my favorite color is amber-gold.')
  wait(lambda:api('/memory/v1/current?scope='+scope),lambda v:any('amber-gold' in r['event']['content'] for r in v.get('records',[])),label='pre-fault current fact')
  assert "'" not in scope
  def block():
   try:q("begin read write;set application_name='rc-correction-lock';select scope from memory_authority_scopes where scope='"+scope+"' for update;select pg_sleep(90);commit")
   except subprocess.CalledProcessError:pass # Expected disconnect when the owned PG stops.
  lock=threading.Thread(target=block,daemon=True);lock.start()
  wait(lambda:q("select count(*) from pg_stat_activity where application_name='rc-correction-lock' and wait_event='PgSleep'"),lambda x:x=='1',label='scope row lock')
  # Normal UI input; the separate lab SQL connection only holds a lock, never writes memory.
  fill('textarea','Correction: my favorite color is forest-green, not amber-gold.')
  script("document.querySelector('[aria-label=\"Send message\"],[aria-label=\"发送消息\"]').click();return true;")
  wait(lambda:q("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%memory_authority_scopes%'"),lambda x:int(x)>0,label='memory correction blocked at scope lock')
 if mode=='managed-effect':
  fill('textarea','RC_UNKNOWN_PROBE: acknowledge this synthetic execution probe.')
  script("document.querySelector('[aria-label=\"Send message\"],[aria-label=\"发送消息\"]').click();return true;")
  wait(lambda:(OUT/'fixture-unknown-accepted.json').exists(),label='Fixture accepted the actual user dispatch')
  probes=json.loads(q("select coalesce(json_agg(t),'[]') from (select attempt_id,adapter,dispatch_started_at from effect_attempts a where dispatch_started_at is not null and not exists(select 1 from effect_observations o where o.attempt_id=a.attempt_id and category='TERMINAL'))t"))
  assert probes;(OUT/'unresolved-at-backup.json').write_text(json.dumps(probes,indent=2))
 before=tools['capture']();(OUT/'before-last-managed-fault.json').write_text(json.dumps(before,indent=2))
 record,unit,members=managed();snapshot=native('get_service_status')
 runtime=next(s for s in snapshot['services'] if s['id']=='runtime')['pid']
 pg=int((STATE/'data/Postgres/data/postmaster.pid').read_text().splitlines()[0])
 sup=json.loads((STATE/'supervisor/active-instance.json').read_text())['pid']
 saved_lock=json.loads((STATE/'supervisor/supervisor.instance.lock').read_text())
 targets={'managed-supervisor':[sup],'managed-launcher':[record['launcherPid']],'managed-both':[sup,runtime],
  'managed-pg':[pg],'managed-concurrent':[record['launcherPid']],'managed-effect':[sup],'managed-correction':[sup]}[mode]
 assert all(pid in [m['pid'] for m in members] for pid in targets)
 handles=[os.pidfd_open(pid) for pid in targets]
 try:
  for fd in handles:signal.pidfd_send_signal(fd,signal.SIGKILL)
 finally:
  for fd in handles:os.close(fd)
 if mode!='managed-pg':
  cg=pathlib.Path('/sys/fs/cgroup')/record['controlGroup'].lstrip('/')/'cgroup.procs'
  wait(lambda:not cg.exists() or not cg.read_text().strip(),label='OS cgroup empty without manual cleanup',timeout=55)
 else:
  def closed():
   try:api('/memory/v1/current?scope='+scope);return False
   except (RuntimeError,AssertionError):return True
  wait(closed,label='private API refuses dead PG')
 concurrent=None
 if mode=='managed-concurrent':
  with open(BASE/'concurrent-a.log','w') as a,open(BASE/'concurrent-b.log','w') as b:
   children=[subprocess.Popen([str(BASE/'yuvi/yuvi')],stdout=f,stderr=subprocess.STDOUT) for f in (a,b)]
   wait(lambda:json.loads((STATE/'supervisor/lifecycle.json').read_text()),lambda r:r['invocationId']!=record['invocationId'],label='new invocation won the concurrent start')
   wait(lambda:q('select 1'),lambda x:x=='1',label='new private PostgreSQL ready')
   def ready():
    r,u,ms=managed()
    runtimes=[m for m in ms if b'/home/tester/yuvi/runtime/yuvi-runtime-server.mjs' in pathlib.Path('/proc/'+str(m['pid'])+'/cmdline').read_bytes()]
    return (r,u,ms) if len(runtimes)==1 else None
   newrecord,_,newmembers=wait(ready,label='one owned Runtime')
   wait(lambda:[p.poll() for p in children],lambda rs:rs.count(None)==1 and sum(x not in (None,0) for x in rs)==1,label='one launcher accepted, one refused')
   concurrent={'newLifecycle':newrecord,'processes':newmembers,'oneAcceptedOneRefused':True}
   subprocess.run([str(BASE/'yuvi/yuvi'),'stop'],check=True,timeout=50)
   for child in children:child.wait(timeout=55)
   cg=pathlib.Path('/sys/fs/cgroup')/newrecord['controlGroup'].lstrip('/')/'cgroup.procs'
   wait(lambda:not cg.exists() or not cg.read_text().strip(),label='normal stop of the single winning instance',timeout=55)
 if lock:lock.join(timeout=3)
 result={'scriptSha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [BASE/'managed-lifecycle.py',BASE/'native-install.py',BASE/'run-guest.sh']},'status':'INJECTED_REQUIRES_NATIVE_REOPEN','mode':mode,'lifecycle':record,'supervisorLock':saved_lock,'unitBefore':unit,'processesBefore':members,
  'concurrentRecovery':concurrent,'killedPids':targets,'osCgroupCleaned':mode!='managed-pg','manualCleanup':False,
  'notes':'Actual packaged processes killed by pinned pidfd. Compare durable state after normal native reopen; no real external side effects.'}
 (OUT/('result-'+mode+'.json')).write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
 return result
