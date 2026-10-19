#!/usr/bin/env python3
"""Bounded ENOSPC experiment on a NEW loop filesystem in the disposable VM only.
Copies stopped synthetic state solely for fault injection, never for a first-run claim.
"""
import errno,hashlib,json,os,pathlib,signal,subprocess,time
assert os.uname().nodename=='yuvi-rc' and os.getuid()==1000
base=pathlib.Path('/home/tester');source=base/'.local/share/YUVI/portable/0.1.2'
image=base/'rc-enospc2.img';volume=base/'rc-enospc2';evidence=base/'rc-evidence/result-enospc.json'
assert not image.exists() and not volume.exists(),'Refusing to overwrite previous fault material'
assert not (source/'data/Postgres/data/postmaster.pid').exists(),'Stop the owned product before copying synthetic test state'
control=source/'data/Postgres/data/global/pg_control';before=hashlib.sha256(control.read_bytes()).hexdigest()
volume.mkdir(mode=0o700)
subprocess.run(['truncate','-s','160M',str(image)],check=True);image.chmod(0o600)
subprocess.run(['/usr/sbin/mkfs.ext4','-q','-F','-m','0',str(image)],check=True)
subprocess.run(['sudo','mount','-o','loop',str(image),str(volume)],check=True)
try:
 subprocess.run(['sudo','chown','tester:tester',str(volume)],check=True)
 subprocess.run(['cp','-a',str(source),str(volume/'state')],check=True)
 fd=os.open(volume/'filler',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);written=0
 try:
  # Large writes can encounter ENOSPC while a few smaller allocations remain.
  # Preserve the first failed setup image and exhaust this new attempt at block
  # granularity; the kernel's write failure is the fault, not f_bavail == 0.
  for size in (1024*1024,4096):
   try:
    while True:written+=os.write(fd,b'\0'*size)
   except OSError as e:
    if e.errno!=errno.ENOSPC:raise
  os.fsync(fd)
 finally:os.close(fd)
 available=os.statvfs(volume).f_bavail*os.statvfs(volume).f_frsize
 env={**os.environ,'YUVI_PORTABLE_STATE_ROOT':str(volume/'state')}
 start=time.monotonic();proc=subprocess.Popen([str(base/'yuvi/yuvi')],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
 try:out,err=proc.communicate(timeout=35)
 except subprocess.TimeoutExpired:
  os.killpg(proc.pid,signal.SIGTERM);proc.communicate(timeout=10);raise RuntimeError('Full-volume startup did not stop within the bounded deadline')
 assert proc.returncode!=0 and ('ENOSPC' in out+err or 'no space left' in (out+err).lower()),'Startup failed for another reason or reported success: '+(out+err)[-1600:]
 assert not (volume/'state/data/Postgres/data/postmaster.pid').exists(),'Full filesystem must not start PG'
 assert before==hashlib.sha256(control.read_bytes()).hexdigest(),'Original cluster was modified'
 result={'status':'PASS','scenario':'160MiB isolated ext4 volume exhausted before packaged startup','bytesFilled':written,'availableBytesReported':available,'seconds':time.monotonic()-start,'exitCode':proc.returncode,'error':'ENOSPC','originalClusterUnchanged':True,'copiedClusterStarted':False,'note':'No initial-install claim; copied synthetic state only, source stopped, no chat or model executed'}
 evidence.write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally:
 subprocess.run(['sudo','umount',str(volume)],check=True)
