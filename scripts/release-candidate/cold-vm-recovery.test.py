"""Fault regressions for the external recovery custody boundary; no production service needed."""
import concurrent.futures, hashlib, json, pathlib, subprocess, tempfile, unittest
SCRIPT=pathlib.Path(__file__).with_name('cold-vm-recovery.py')
BOOT='b71012ce-cff9-4a3c-a89d-b2c68d3b574b'
class RecoveryCustody(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.backup=self.root/'backup';self.backup.mkdir(mode=0o700)
  self.registry=self.root/'registry.json'
  self.put(self.backup/'machine.qcow2',b'synthetic sealed bytes')
  self.put(self.backup/'seal.json',{'backupId':'test-backup','databaseState':'shut down','activeHostGrants':0})
  self.put(self.backup/'release.json',{'checkoutSha':'a'*40})
  m={'schema':'yuvi.cold-machine-backup.v1','backupId':'test-backup','checkoutSha':'a'*40,
    'diskSha256':self.sha('machine.qcow2'),'sealSha256':self.sha('seal.json'),'releaseManifestSha256':self.sha('release.json')}
  self.put(self.backup/'manifest.json',m)
  self.put(self.registry,{'schema':'yuvi.cold-recovery-registry.v1','state':'SEALED','backupId':'test-backup','manifestSha256':self.sha('manifest.json')})
  self.audit=self.root/'audit.json';self.put(self.audit,{'backupId':'test-backup','deletionReview':'NO_UNRECONCILED_DELETIONS','executionReview':'NO_POST_POINT_EFFECTS','reviewer':'synthetic test','basis':'Source stopped; no external effects'})
 def tearDown(self):self.tmp.cleanup()
 def put(self,p,v):p.write_bytes(v if isinstance(v,bytes) else json.dumps(v).encode());p.chmod(0o600)
 def sha(self,name):return hashlib.sha256((self.backup/name).read_bytes()).hexdigest()
 def clearance(self,name='clearance.json',boot=BOOT):
  return subprocess.run(['python3',str(SCRIPT),'clearance','--backup',str(self.backup),'--registry',str(self.registry),'--audit',str(self.audit),'--output',str(self.root/name),'--target-boot-id',boot],capture_output=True,text=True)
 def test_single_activation_invalidates_old_restore_point_before_writes(self):
  self.assertEqual(self.clearance().returncode,0)
  self.assertEqual(json.loads(self.registry.read_text())['state'],'RESTORE_ACTIVATED_RECONCILIATION_REQUIRED')
  self.assertIn('RECONCILIATION_REQUIRED',self.clearance('second.json').stderr)
  self.assertFalse((self.root/'second.json').exists())
 def test_concurrent_clearances_cannot_both_activate(self):
  with concurrent.futures.ThreadPoolExecutor() as pool:results=list(pool.map(self.clearance,['a.json','b.json']))
  self.assertEqual(sum(r.returncode==0 for r in results),1)
 def test_tampered_snapshot_stays_closed(self):
  self.put(self.backup/'machine.qcow2',b'changed');self.assertIn('BACKUP_INTEGRITY_FAILED',self.clearance().stderr)
  self.assertEqual(json.loads(self.registry.read_text())['state'],'SEALED')
 def test_unreviewed_deletions_and_wrong_boot_stay_closed(self):
  self.assertNotEqual(self.clearance(boot='other-machine').returncode,0)
  a=json.loads(self.audit.read_text());a['deletionReview']='UNKNOWN';self.put(self.audit,a)
  self.assertIn('DELETION_AND_EXECUTION_AUDIT_REQUIRED',self.clearance().stderr)
  self.assertFalse((self.root/'clearance.json').exists())
 def test_missing_external_custody_never_reconstructs_authorization(self):
  self.registry.unlink();self.assertNotEqual(self.clearance().returncode,0)
  self.assertFalse((self.root/'clearance.json').exists())
if __name__=='__main__':unittest.main()
