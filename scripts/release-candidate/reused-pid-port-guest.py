#!/usr/bin/env python3
"""Root ONLY in the disposable VM: reuse an old Supervisor PID for an unrelated lookalike.
No existing process is ever signalled. Only the newly forked child is held/signalled by pidfd.
"""
import pathlib,os,json,subprocess,hashlib,time,signal,urllib.request
assert os.getuid()==0 and os.uname().nodename=='yuvi-rc'
base=pathlib.Path('/home/tester');state=base/'.local/share/YUVI/portable/0.1.2'
assert not (state/'data/Postgres/data/postmaster.pid').exists(),'Stop the synthetic product first'
old=next(json.loads(f.read_text())['supervisorLock'] for f in sorted((base/'rc-evidence').glob('result-managed-*.json')) if 'supervisorLock' in json.loads(f.read_text()) and not pathlib.Path('/proc/'+str(json.loads(f.read_text())['supervisorLock']['pid'])).exists())
pid=old['pid']
assert not pathlib.Path('/proc/'+str(pid)).exists(),'Old PID must already be gone; no process will be removed'
look=base/'yuvi-lookalike/runtime';look.mkdir(parents=True,exist_ok=False)
script=look/'yuvi-runtime-server.mjs'
script.write_text("import http from 'node:http';const s=http.createServer((q,r)=>{if(q.url==='/__fixture_release_port'){r.end('release own fixture port');s.close();setInterval(()=>{},5000);return}r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'ok',runtimeInstanceId:'unrelated-lookalike'}))});s.listen(16121,'127.0.0.1');")
control=state/'data/Postgres/data/global/pg_control';before=hashlib.sha256(control.read_bytes()).hexdigest()
# Actual kernel allocator reuse, not a fabricated PID assertion. A concurrent
# guest fork may win the slot; in that case preserve the failure and stop.
pathlib.Path('/proc/sys/kernel/ns_last_pid').write_text(str(pid-1))
child=os.fork()
if child==0:
 os.setgroups([]);os.setgid(1000);os.setuid(1000)
 os.execl(str(base/'yuvi/runtime/node'),'node',str(script))
fd=os.pidfd_open(child)
try:
 assert child==pid,f'Actual PID reuse setup lost the allocator race: wanted {pid}, got {child}'
 deadline=time.monotonic()+5
 while True:
  try:
   with urllib.request.urlopen('http://127.0.0.1:16121/health',timeout=1) as r:health=json.load(r)
   break
  except OSError:
   if time.monotonic()>deadline:raise
   time.sleep(.05)
 p=pathlib.Path('/proc')/str(child)
 process={'pid':child,'uid':p.stat().st_uid,'startTicks':(p/'stat').read_text().rsplit(') ',1)[1].split()[19],
  'executable':str((p/'exe').readlink()),'cgroup':(p/'cgroup').read_text().strip(),'healthyLookalike':health}
 r=subprocess.run(['/usr/sbin/runuser','-u','tester','--',str(base/'yuvi/yuvi')],env={'PATH':'/usr/bin:/bin','YUVI_PORTABLE_STATE_ROOT':str(state)},capture_output=True,text=True,timeout=15)
 assert r.returncode!=0 and 'Port 16121 is occupied' in r.stderr
 signal.pidfd_send_signal(fd,0)
 assert before==hashlib.sha256(control.read_bytes()).hexdigest()
 # The test-owned lookalike releases its own port but stays alive. Inject its
 # genuine old kernel lock snapshot; normal product startup must retire only
 # that stale file, never signal the replacement process.
 with urllib.request.urlopen('http://127.0.0.1:16121/__fixture_release_port') as response:response.read()
 lock=state/'supervisor/supervisor.instance.lock';assert not lock.exists()
 lock.write_text(json.dumps(old));os.chown(lock,1000,1000);lock.chmod(0o600)
 reopened=subprocess.run(['/usr/sbin/runuser','-u','tester','--','bash',str(base/'run-guest.sh'),'restart'],env={'PATH':'/usr/bin:/bin','HOME':'/home/tester'},capture_output=True,text=True,timeout=120)
 assert reopened.returncode==0,reopened.stdout+reopened.stderr
 signal.pidfd_send_signal(fd,0)
 result={'staleKernelLockRetiredByNormalNativeStartup':True,'oldKernelIdentity':old,'replacementAliveAfterNativeChat':True,'status':'PASS','actualPidReuse':True,'oldSupervisorPid':pid,'replacementProcess':process,'productExit':r.returncode,
  'diagnostic':'PORT_OCCUPIED_NO_ADOPTION_OR_SIGNAL','pgControlUnchanged':True,'unrelatedProcessRemainedAlive':True,
  'scope':'Same UID and Node executable, similar path and healthy HTTP endpoint; actual old pointer PID recycled outside the application cgroup'}
 out=base/'rc-evidence/result-managed-pid-reuse-port.json';out.write_text(json.dumps(result,indent=2));os.chown(out,1000,1000);print(json.dumps(result))
finally:
 signal.pidfd_send_signal(fd,signal.SIGTERM);os.close(fd);os.waitpid(child,0)
