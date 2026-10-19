#!/usr/bin/env python3
"""Call only after native logout inside the disposable guest's unlocked Secret Service session."""
import json,pathlib,subprocess,time,hashlib,os,runpy
m=runpy.run_path('/home/tester/guest-db.py');sql=m['sql'];root=m['ROOT'];pkg=m['PKG']
assert os.uname().nodename=='yuvi-rc'
active=int(sql('select count(*) from memory_host_grants where revoked_at is null'))
assert active==0,'Sign out every product client before sealing'
pending=int(sql("select count(*) from finalized_ingestion_turns where status in ('pending','processing','retryable_failed','reconcile_required')"))
assert pending==0,'Drain or explicitly reconcile unfinished ingestion before this bounded cold seal'
snapshot=m['capture']()
assert int(sql('select count(*) from yuvi_schema_migrations'))==45
# This test has no external real-world effect. Preserve any unresolved A9 attempt as unknown, never retry it.
subprocess.run([str(pkg/'yuvi'),'prepare-backup'],check=True)
end=time.monotonic()+90
while (root/'data/Postgres/data/postmaster.pid').exists():
 if time.monotonic()>end:raise RuntimeError('PostgreSQL still running; backup prohibited')
 time.sleep(.2)
control=subprocess.check_output([str(pkg/'postgres/bin/pg_controldata'),str(root/'data/Postgres/data')],env={**os.environ,'LC_ALL':'C'},text=True)
state=next(x.split(':',1)[1].strip() for x in control.splitlines() if x.startswith('Database cluster state:'))
assert state=='shut down'
gate=json.loads((root/'recovery-required.json').read_text());release=json.loads((pkg/'install-manifest.json').read_text())
assert gate['checkoutSha']==release['checkoutSha']
files=[]
for base in [root/'config',pathlib.Path('/home/tester/.local/share/keyrings')]:
 for p in sorted(base.rglob('*')):
  if p.is_file():files.append({'path':str(p.relative_to('/home/tester')),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
seal={**gate,'schema':'yuvi.cold-seal.v1','databaseState':state,'schemaCount':45,'activeHostGrants':active,
 'nativeOwnerDigest':snapshot['identity']['nativeOwnerDigest'],'snapshot':snapshot,'files':files,
 'postgresMajor':16,'postgresVersion':subprocess.check_output([str(pkg/'postgres/bin/postgres'),'--version'],text=True).strip(),
 'recoveryScope':'Whole powered-off Debian VM, same OS/user/keyring unlock; source must remain offline',
 'unverifiedPopulatedAssets':['expired/deleted Observation','legacy Mem0/Profile/Dream','P8 edits'],
 'privacyReview':'No private real assets; source remains powered off. Any later deletion or external effect invalidates this recovery point.'}
p=pathlib.Path('/home/tester/cold-seal.json');fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:json.dump(seal,f,indent=2);f.flush();os.fsync(f.fileno())
# Launcher must reject before starting any process.
r=subprocess.run([str(pkg/'yuvi')],capture_output=True,text=True)
assert r.returncode!=0 and 'RECOVERY_REVIEW_REQUIRED' in r.stderr+r.stdout
print(json.dumps({'status':'COLD_SEALED_NOT_YET_BACKED_UP','backupId':gate['backupId'],'databaseState':state,'activeHostGrants':active}),flush=True)
