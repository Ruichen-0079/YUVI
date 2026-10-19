#!/usr/bin/env python3
"""Bounded cold Debian VM recovery. No online backup, arbitrary downgrade or privacy-erasure claim.
An external private registry is deliberately not part of the historical backup.
"""
import argparse, hashlib, json, os, pathlib, stat, subprocess, datetime
import re, fcntl, shutil

def digest(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()
def sync_file(p):
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
def sync_directory(p):
    fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)
def read(p):return json.loads(pathlib.Path(p).read_text())
def private_parent(p):
    p=pathlib.Path(p).resolve();p.mkdir(mode=0o700,parents=True,exist_ok=True)
    s=p.stat()
    if s.st_uid!=os.getuid() or s.st_mode & 0o077:raise ValueError('Private owned mode-0700 directory required')
    return p

def write(p,value):
    p=pathlib.Path(p);private_parent(p.parent)
    tmp=p.with_name(p.name+'.pending')
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,'w') as f:json.dump(value,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
        os.replace(tmp,p)
        d=os.open(p.parent,os.O_RDONLY)
        try:os.fsync(d)
        finally:os.close(d)
    finally:
        if tmp.exists():tmp.unlink()

def require_new(p):
    p=pathlib.Path(p).resolve()
    if p.exists():raise ValueError('Refusing to overwrite recovery output: '+str(p))
    private_parent(p.parent)
    return p

def verify(backup,registry):
    backup=pathlib.Path(backup).resolve();m=read(backup/'manifest.json');r=read(registry)
    if m['schema']!='yuvi.cold-machine-backup.v1' or r['schema']!='yuvi.cold-recovery-registry.v1':raise ValueError('Recovery schema mismatch')
    if r['state']!='SEALED' or r['backupId']!=m['backupId'] or r['manifestSha256']!=digest(backup/'manifest.json'):
        raise ValueError('RECONCILIATION_REQUIRED: source resumed, a later recovery point exists, or custody changed. Review A9 effects and privacy deletions; no automatic rollback.')
    if digest(backup/'seed.iso')!=m['seedSha256']:raise ValueError('BACKUP_BOOT_METADATA_INTEGRITY_FAILED')
    if digest(backup/'machine.qcow2')!=m['diskSha256']:raise ValueError('BACKUP_INTEGRITY_FAILED')
    if digest(backup/'seal.json')!=m['sealSha256'] or digest(backup/'release.json')!=m['releaseManifestSha256']:raise ValueError('BACKUP_METADATA_INTEGRITY_FAILED')
    seal=read(backup/'seal.json')
    if seal['backupId']!=m['backupId'] or seal['databaseState']!='shut down' or seal['activeHostGrants']!=0:
        raise ValueError('BACKUP_NOT_QUIESCENT_OR_AUTHORIZATION_NOT_REVOKED')
    return m,r

def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    b=sub.add_parser('backup')
    for k in ['disk','seed','seal','release','serial','destination','registry']:b.add_argument('--'+k,required=True)
    r=sub.add_parser('restore')
    for k in ['backup','registry','disk']:r.add_argument('--'+k,required=True)
    c=sub.add_parser('clearance')
    for k in ['backup','registry','audit','output','target-boot-id']:c.add_argument('--'+k,required=True)
    c.add_argument('--resume-source',action='store_true')
    a=p.parse_args()
    # Serialize custody transitions; a second concurrent clearance cannot revive a point.
    registry=pathlib.Path(a.registry).absolute();private_parent(registry.parent)
    backup_dir=pathlib.Path(a.destination if a.command=='backup' else a.backup).resolve()
    if registry.resolve().is_relative_to(backup_dir):raise ValueError('Recovery custody registry must be external to the historical backup')
    lock=os.open(str(registry)+'.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    info=os.fstat(lock)
    if info.st_uid!=os.getuid() or info.st_mode & 0o077 or not stat.S_ISREG(info.st_mode):raise ValueError('Private owned registry lock required')
    fcntl.flock(lock,fcntl.LOCK_EX)
    if a.command=='backup':
        require_new(a.registry)
        out=require_new(a.destination);out.mkdir(mode=0o700)
        seal=read(a.seal);release=read(a.release)
        if seal['databaseState']!='shut down' or seal['activeHostGrants']!=0 or seal['schemaCount']!=45 or not seal.get('nativeOwnerDigest'):
            raise ValueError('COLD_SEAL_INCOMPLETE')
        if seal['checkoutSha']!=release['checkoutSha']:raise ValueError('SEAL_RELEASE_MISMATCH')
        if 'Power down' not in pathlib.Path(a.serial).read_text(errors='replace')[-12000:]:raise ValueError('Clean guest poweroff evidence required')
        # qemu-img's exclusive image lock rejects an active VM. Never force-share.
        subprocess.run(['qemu-img','check',a.disk],check=True)
        subprocess.run(['qemu-img','convert','-c','-O','qcow2',a.disk,str(out/'machine.qcow2')],check=True)
        os.chmod(out/'machine.qcow2',0o600)
        info=json.loads(subprocess.check_output(['qemu-img','info','--output=json',str(out/'machine.qcow2')]))
        if info.get('backing-filename'):raise ValueError('Backup still depends on source image')
        shutil.copyfile(a.seed,out/'seed.iso');os.chmod(out/'seed.iso',0o600)
        sync_file(out/'machine.qcow2');sync_file(out/'seed.iso')
        write(out/'seal.json',seal);write(out/'release.json',release)
        manifest={'schema':'yuvi.cold-machine-backup.v1','backupId':seal['backupId'],'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'checkoutSha':release['checkoutSha'],'diskSha256':digest(out/'machine.qcow2'),'seedSha256':digest(out/'seed.iso'),'sealSha256':digest(out/'seal.json'),'releaseManifestSha256':digest(out/'release.json'),
          'recoveryBoundary':'Whole stopped VM filesystem including PG, ProductStore, native owner, encrypted system keyring and static assets; same OS/user/keyring password required.',
          'limitations':['Not online/PITR or cross-OS account/keyring restore','No global historical-backup privacy erasure','Source resume or newer deletions/effects require external reconciliation; never restore an older database automatically']}
        write(out/'manifest.json',manifest)
        sync_directory(out.parent)
        write(a.registry,{'schema':'yuvi.cold-recovery-registry.v1','backupId':manifest['backupId'],'manifestSha256':digest(out/'manifest.json'),'state':'SEALED'})
        print(json.dumps({'status':'BACKUP_COMPLETE','backupId':seal['backupId'],'bytes':(out/'machine.qcow2').stat().st_size}))
    elif a.command=='restore':
        m,_=verify(a.backup,a.registry);disk=require_new(a.disk)
        seed=require_new(disk.parent/'seed.iso')
        subprocess.run(['qemu-img','convert','-O','qcow2',str(pathlib.Path(a.backup)/'machine.qcow2'),str(disk)],check=True)
        os.chmod(disk,0o600)
        shutil.copyfile(pathlib.Path(a.backup)/'seed.iso',seed);os.chmod(seed,0o600)
        sync_file(disk);sync_file(seed);sync_directory(disk.parent)
        print(json.dumps({'status':'RESTORED_BLOCKED_PENDING_REVIEW','backupId':m['backupId'],'disk':str(disk)}))
    else:
        m,r=verify(a.backup,a.registry);audit=read(a.audit)
        if audit.get('backupId')!=m['backupId'] or audit.get('deletionReview')!='NO_UNRECONCILED_DELETIONS' or audit.get('executionReview')!='NO_POST_POINT_EFFECTS' or not audit.get('reviewer') or not audit.get('basis'):
            raise ValueError('DELETION_AND_EXECUTION_AUDIT_REQUIRED')
        output=require_new(a.output)
        if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',a.target_boot_id):raise ValueError('Explicit target Linux boot identity required')
        # Invalidate the historical point BEFORE either source or restored target
        # may write. Multiple staged copies remain closed; no old clearance can
        # activate another VM/boot. A crash here requires audit, never rollback.
        r['state']='SOURCE_RESUMED_RECONCILIATION_REQUIRED' if a.resume_source else 'RESTORE_ACTIVATED_RECONCILIATION_REQUIRED'
        write(a.registry,r)
        write(output,{'schema':'yuvi.cold-recovery-clearance.v1','backupId':m['backupId'],'checkoutSha':m['checkoutSha'],
          'action':'SOURCE_RESUME_INVALIDATES_BACKUP' if a.resume_source else 'SEALED_RESTORE','targetBootId':a.target_boot_id,
          'deletionReview':audit['deletionReview'],'executionReview':audit['executionReview'],'reviewer':audit['reviewer'],'basis':audit['basis'],
          'manifestSha256':digest(pathlib.Path(a.backup)/'manifest.json')})
        print(json.dumps({'status':'REVIEW_RECORDED_NOT_STARTED','backupId':m['backupId']}))
if __name__=='__main__':main()
