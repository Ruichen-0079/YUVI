/** Linux R5 lifecycle containment. systemd owns the cgroup; metadata never authorizes signals. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0,32);
export function lifecycleBinding(root, state, checkoutSha) {
  for (const value of [root,state]) if (/[\n\r\0%$]/.test(value)) throw Error('Managed lifecycle paths cannot contain control characters, % or $.');
  return { unit: `yuvi-r5-${hash(state)}.service`, description: `YUVI R5 ${checkoutSha} ${hash(root)}` };
}
export function parseProperties(text) {
  return Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line => {
    const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)];
  }));
}
export function unifiedCgroup(text) {
  const entry=text.trim().split('\n').find(line=>line.startsWith('0::/'));
  if (!entry) throw Error('LIFECYCLE_CGROUP_V2_REQUIRED');
  return entry.slice(3);
}
export function classifyUnit(unit, binding, current) {
  if (unit.LoadState==='not-found') return 'absent';
  if (unit.Id!==binding.unit || unit.Transient!=='yes' || unit.Description!==binding.description ||
      unit.Type!=='exec' || unit.ExitType!=='main' || unit.KillMode!=='control-group' || unit.Restart!=='no') return 'foreign';
  if (unit.ActiveState==='deactivating') return 'draining';
  if (['inactive','failed'].includes(unit.ActiveState)) return 'stopped';
  if (!['active','activating'].includes(unit.ActiveState) || !/^[a-f0-9]{32}$/.test(unit.InvocationID||'')) return 'foreign';
  if (current && Number(unit.MainPID)===current.pid && unit.InvocationID===current.invocation &&
      unit.ControlGroup===current.cgroup && current.cgroup.endsWith('/'+binding.unit)) return 'self';
  return 'running';
}
const forwarded = ['DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','XAUTHORITY',
  'LANG','GDK_BACKEND','TAURI_WEBVIEW_AUTOMATION','WEBKIT_INSPECTOR_SERVER','WEBKIT_DISABLE_DMABUF_RENDERER','LIBGL_ALWAYS_SOFTWARE'];
export async function enterManagedLifecycle({root,state,supervisorDir,checkoutSha}) {
  const binding=lifecycleBinding(root,fs.realpathSync(state),checkoutSha);
  // Never use an arbitrary session bus supplied by a web page or another app.
  const bus=`/run/user/${process.getuid()}/bus`;
  for (const dir of [state,supervisorDir]) {
    const s=fs.lstatSync(dir);
    if (!s.isDirectory() || s.uid!==process.getuid() || (s.mode & 0o077)) throw Error('LIFECYCLE_PRIVATE_STATE_REQUIRED');
  }
  let info;
  try {info=fs.statSync(bus);} catch {throw Error('LIFECYCLE_USER_MANAGER_REQUIRED: log into a Debian graphical user session with dbus-user-session.');}
  if (!info.isSocket() || info.uid!==process.getuid()) throw Error('LIFECYCLE_USER_MANAGER_REQUIRED: log into a Debian graphical user session with dbus-user-session.');
  const managerEnv={PATH:'/usr/bin:/bin',XDG_RUNTIME_DIR:path.dirname(bus),DBUS_SESSION_BUS_ADDRESS:`unix:path=${bus}`};
  const show=()=>{
    try { return parseProperties(execFileSync('/usr/bin/systemctl',['--user','show',binding.unit,'--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup,Transient,Description,Type,ExitType,KillMode,Restart'],{env:managerEnv,encoding:'utf8',timeout:5000})); }
    catch { throw Error('LIFECYCLE_USER_MANAGER_REQUIRED: no usable user service manager; refusing unmanaged R5 startup.'); }
  };
  const current={pid:process.pid,invocation:process.env.INVOCATION_ID,cgroup:unifiedCgroup(fs.readFileSync('/proc/self/cgroup','utf8'))};
  let unit=show(),classification=classifyUnit(unit,binding,current);
  if (classification==='self') {
    const record={schema:'yuvi.linux-lifecycle.v1',...binding,checkoutSha,packageRoot:root,stateRoot:state,
      bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),invocationId:unit.InvocationID,
      controlGroup:unit.ControlGroup,launcherPid:process.pid,
      startTicks:fs.readFileSync('/proc/self/stat','utf8').split(') ').slice(1).join(') ').split(' ')[19]};
    const target=path.join(supervisorDir,'lifecycle.json'),temp=target+'.'+process.pid+'.tmp';
    const fd=fs.openSync(temp,'wx',0o600);
    try {fs.writeFileSync(fd,JSON.stringify(record,null,2));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    fs.renameSync(temp,target);const dir=fs.openSync(supervisorDir,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    return {delegated:false,cgroup:unit.ControlGroup};
  }
  const deadline=Date.now()+50_000;
  while (classification==='draining' && Date.now()<deadline) {
    await new Promise(resolve=>setTimeout(resolve,250));unit=show();classification=classifyUnit(unit,binding,current);
  }
  if (!['absent','stopped'].includes(classification)) throw Error(`LIFECYCLE_${classification.toUpperCase()}: ${binding.unit}; no process was adopted or signalled. Wait for owned shutdown or inspect the user unit. Existing unmanaged ports must be reconciled separately.`);
  // StartTransientUnit serializes concurrent launchers for this exact state root.
  // --collect unloads failed units only AFTER their cgroup has been stopped.
  const args=['--user','--wait','--pipe','--collect',`--unit=${binding.unit}`,`--description=${binding.description}`,
    '--service-type=exec','--property=ExitType=main','--property=KillMode=control-group','--property=TimeoutStopSec=45s',
    '--property=Restart=no','--property=SendSIGKILL=yes','--property=Delegate=no',`--working-directory=${state}`,
    `--setenv=YUVI_PORTABLE_STATE_ROOT=${state}`];
  for (const key of forwarded) if (process.env[key]) args.push(`--setenv=${key}=${process.env[key]}`);
  args.push('--',path.join(root,'runtime/node'),path.join(root,'launcher.mjs'),'start');
  const child=spawn('/usr/bin/systemd-run',args,{env:managerEnv,stdio:'inherit'});
  const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code)=>resolve(code??1));});
  return {delegated:true,exitCode};
}
