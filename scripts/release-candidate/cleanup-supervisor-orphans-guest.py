#!/usr/bin/env python3
"""Manual laboratory cleanup after the recorded Supervisor SIGKILL, never a product auto-reclaim."""
import json,os,pathlib,signal,subprocess,time
assert os.uname().nodename=='yuvi-rc' and os.getuid()==1000
base=pathlib.Path('/home/tester');lab=base/'.local/share/YUVI/portable/0.1.2';result=base/'rc-evidence/result-supervisor-crash.json'
x=json.loads(result.read_text());orphans=x['observations']['survivingOwnedProcesses']
assert orphans,'No recorded orphan precondition'
r=subprocess.run([str(base/'yuvi/yuvi')],capture_output=True,text=True,timeout=10)
assert r.returncode!=0 and 'Port 16121 is occupied' in r.stderr,'Expected a refused restart, not automatic attachment'
for item in orphans:
 p=pathlib.Path('/proc')/str(item['pid'])
 if not p.exists():continue
 assert p.stat().st_uid==os.getuid()
 cmd=(p/'cmdline').read_bytes()
 if item['service']=='runtime':
  assert b'/home/tester/yuvi/runtime/yuvi-runtime-server.mjs' in cmd
  env=dict(v.split(b'=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
  assert env.get(b'YUVI_CONFIG_ROOT')==str(lab/'config').encode(),'Different Runtime state; no signal sent'
  os.kill(item['pid'],signal.SIGTERM)
 elif item['service']=='postgres':
  assert b'/home/tester/yuvi/postgres/bin/postgres' in cmd and str(lab/'data/Postgres/data').encode() in cmd
  subprocess.run([str(base/'yuvi/postgres/bin/pg_ctl'),'-D',str(lab/'data/Postgres/data'),'-m','fast','-w','stop'],check=True,timeout=30)
 else:raise AssertionError('Unknown recorded service')
x['status']='BLOCKED_AUTOMATIC_RESTART';x['observations']['restartRefused']=True;x['observations']['manualOwnedLabCleanup']=True
result.write_text(json.dumps(x,indent=2));print(json.dumps(x))
