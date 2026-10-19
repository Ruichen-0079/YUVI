#!/usr/bin/env python3
"""No production discovery; run only while the synthetic managed guest instance is active."""
import os,pathlib,runpy,subprocess,json,concurrent.futures
assert os.uname().nodename=='yuvi-rc' and os.getuid()==1000
base=pathlib.Path('/home/tester');tools=runpy.run_path(str(base/'managed-lifecycle.py'));before,unit,members=tools['managed']()
app=base/'yuvi/yuvi';copy=base/'yuvi-second-release';state=base/'second-instance-state'
assert not copy.exists() and not state.exists(),'Preserve previous negative experiment material'
# Same actual distribution, different install root and state; no preconfigured identity.
subprocess.run(['cp','-a',str(base/'yuvi'),str(copy)],check=True)
r=subprocess.run([str(copy/'yuvi')],env={**os.environ,'YUVI_PORTABLE_STATE_ROOT':str(state)},capture_output=True,text=True,timeout=15)
assert r.returncode!=0 and 'Port 16121 is occupied' in r.stderr
assert not (state/'data/Postgres/data/PG_VERSION').exists()
def refuse(_):
 r=subprocess.run([str(app)],capture_output=True,text=True,timeout=10)
 assert r.returncode!=0 and 'LIFECYCLE_RUNNING' in r.stderr
 return {'exitCode':r.returncode,'diagnostic':'LIFECYCLE_RUNNING'}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:attempts=list(pool.map(refuse,range(2)))
after,_,_=tools['managed']();assert before['invocationId']==after['invocationId']
for old in members:
 try:
  new=tools['identity'](old['pid']);assert new['startTicks']==old['startTicks']
 except FileNotFoundError:pass # Short-lived SQL/WebKit worker may finish naturally.
result={'status':'PASS','activeLifecycle':before,'differentInstallAndState':{'refused':'PORT_OCCUPIED','privatePGNotInitialized':True,'exitCode':r.returncode},
 'concurrentLaunchersAgainstActiveInstance':attempts,'originalInvocationUnchanged':True,'noSignalsSentByTest':True}
(base/'rc-evidence/result-managed-negative-active.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
