/** Public extract-and-run owner; service lifecycle remains DesktopSupervisor's. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { portableSecretNamespace, readPortablePackageIdentity, resolvePortableStateDirs, resolvePortableStateRoot } from './portable-state.mjs';
import { CUBISM_CORE_FILENAME, cubismCoreStatus, provisionCubismCore } from './provision-cubism-core.mjs';
const root = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const packageIdentity = readPortablePackageIdentity(root);
const r5Only = JSON.parse(fs.readFileSync(path.join(root, 'install-manifest.json'), 'utf8')).profile === 'r5';
const secretNamespace = portableSecretNamespace(packageIdentity);
const state = resolvePortableStateRoot({ packageRoot: root, identity: packageIdentity });
const dirs = resolvePortableStateDirs(state);
process.umask(0o077);
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const pointer = path.join(dirs.supervisor, 'active-instance.json');
const recoveryGate = path.join(state, 'recovery-required.json');
const desktopShell = path.join(root, 'desktop', 'yuvi-desktop');
if (!fs.existsSync(desktopShell)) throw new Error('Portable desktop shell is missing.');
let expectedSupervisorPid;
async function control(route) {
  const active = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  if (expectedSupervisorPid && active.pid !== expectedSupervisorPid) throw new Error('Waiting for this launcher’s Supervisor identity.');
  if (!path.resolve(active.endpointFile).startsWith(dirs.supervisor + path.sep)) throw new Error('No active instance at this portable location.');
  const endpoint = JSON.parse(fs.readFileSync(active.endpointFile, 'utf8'));
  if (endpoint.instanceId !== active.instanceId || endpoint.pid !== active.pid || endpoint.host !== '127.0.0.1' || !Number.isInteger(endpoint.port)) throw new Error('Invalid portable instance identity.');
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, { method: route === '/v1/status' ? 'GET' : 'POST', headers: { 'x-yuvi-control-token': endpoint.controlToken }, signal: AbortSignal.timeout(90_000), redirect: 'error' });
  if (!response.ok) throw new Error('Portable instance is unavailable.');
  const result = await response.json();
  if (route === '/v1/status' && result.instanceId !== active.instanceId) throw new Error('Portable instance identity changed.');
  return result;
}
async function available(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied. Stop the other application before launching this portable copy.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
const command = process.argv[2] || 'start';
try {
  if (command === 'status') {
    const status = await control('/v1/status');
    console.log(JSON.stringify({ running: true, services: status.services.map(s => ({ id: s.id, status: s.status })) }, null, 2));
  } else if (command === 'stop') {
    await control('/v1/shutdown');
    console.log('YUVI shutdown requested.');
  } else if (command === 'cubism-core') {
    const action = process.argv[3] || 'status';
    if (action === 'status') {
      console.log(JSON.stringify(cubismCoreStatus({ dataRoot: dirs.data }), null, 2));
    } else if (action === 'import') {
      const sourcePath = process.argv[4];
      if (!sourcePath) throw new Error(`Usage: ./yuvi cubism-core import /path/to/${CUBISM_CORE_FILENAME}`);
      const result = provisionCubismCore({ sourcePath, dataRoot: dirs.data });
      console.log(`Cubism Core provisioned: ${result.destination}\nsha256=${result.sha256}\nRestart YUVI before loading Live2D.`);
    } else {
      throw new Error('Usage: ./yuvi cubism-core [status|import /path/to/live2dcubismcore.min.js]');
    }
  } else if (command === 'review-recovery') {
    const gate = JSON.parse(fs.readFileSync(recoveryGate, 'utf8'));
    const clearancePath = process.argv[3];
    if (!clearancePath || !path.isAbsolute(clearancePath)) throw new Error('An explicit private recovery clearance file is required.');
    const fd = fs.openSync(clearancePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let clearance;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Recovery clearance must be an owned mode-0600 file.');
      clearance = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
    if (gate.schema !== 'yuvi.cold-recovery-gate.v1' || clearance.schema !== 'yuvi.cold-recovery-clearance.v1' ||
        clearance.backupId !== gate.backupId || clearance.checkoutSha !== packageIdentity.checkoutSha ||
        !['SEALED_RESTORE', 'SOURCE_RESUME_INVALIDATES_BACKUP'].includes(clearance.action) ||
        clearance.deletionReview !== 'NO_UNRECONCILED_DELETIONS' || clearance.executionReview !== 'NO_POST_POINT_EFFECTS') {
      throw new Error('RECOVERY_RECONCILIATION_REQUIRED: missing or incompatible deletion/execution review.');
    }
    const receipt = path.join(state, `recovery-review-${gate.backupId}.json`);
    const out = fs.openSync(receipt, 'wx', 0o600);
    try { fs.writeFileSync(out, JSON.stringify(clearance)); fs.fsyncSync(out); } finally { fs.closeSync(out); }
    fs.unlinkSync(recoveryGate);
    const dir = fs.openSync(state, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    console.log('Recovery review recorded. No services started; explicitly launch YUVI and confirm the existing native identity.');
  } else if (command === 'prepare-backup') {
    // Seal before stopping writers. A crash leaves the next launch closed.
    // This is a preparation receipt, never a claim that a backup is complete.
    if (!fs.existsSync(recoveryGate)) {
      const fd = fs.openSync(recoveryGate, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ schema: 'yuvi.cold-recovery-gate.v1', backupId: randomUUID(), checkoutSha: packageIdentity.checkoutSha, createdAt: new Date().toISOString() }));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      const dir = fs.openSync(state, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    await control('/v1/shutdown');
    console.log('Writers are stopping; the next launch is blocked. Verify offline PostgreSQL, sign-out and the full recovery seal before backing up.');
  } else if (command === 'start') {
    if (fs.existsSync(recoveryGate)) throw new Error('RECOVERY_REVIEW_REQUIRED: this state is sealed. Restore or source-resume requires the external recovery registry and deletion/execution audit; no services were started.');
    // Legacy env files can override both the Supervisor and Runtime transport
    // and state roots. Product settings/secrets are the Portable authority.
    for (const name of ['.env', '.env.local']) {
      if (fs.existsSync(path.join(dirs.config, name))) throw new Error(`Portable cannot prove isolation with legacy ${name} in ${dirs.config}. Move that file aside and use Product settings.`);
    }
    const runtimePort = 16121, webPort = 15173, sttPort = 19876;
    for (const port of r5Only ? [runtimePort, webPort] : [runtimePort, webPort, sttPort, 16131, 19881, 19880]) await available(port);
    // Parent provider credentials and Installed state never cross the Portable boundary.
    // Durable Product configuration and secrets are restored only from this release namespace.
    const guiSessionEnv = Object.fromEntries(
      ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY']
        .filter(key => typeof process.env[key] === 'string' && process.env[key])
        .map(key => [key, process.env[key]])
    );
    const env = {
      ...guiSessionEnv,
      PATH: '/usr/bin:/bin', HOME: dirs.home, LANG: process.env.LANG || 'C.UTF-8',
      XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache,
      TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp,
      YUVI_CONFIG_ROOT: dirs.config, YUVI_DATA_ROOT: dirs.data, YUVI_CACHE_ROOT: dirs.cache,
      YUVI_RUNTIME_ENV_DIR: dirs.config, YUVI_SUPERVISOR_STATE_ROOT: dirs.supervisor,
      YUVI_SECRET_NAMESPACE: secretNamespace,
      YUVI_PORTABLE_VERSION: packageIdentity.version,
      ...(r5Only ? { YUVI_PACKAGE_PROFILE: 'r5', MEMORY_BACKEND: 'legacy', YUVI_PACKAGED_EXTERNAL_SIDECARS: '1', YUVI_AUTOSTART_MEM0: '0', YUVI_AUTOSTART_LOCAL_STT: '0' } : {}),
      YUVI_POSTGRES_MODE: 'private',
      YUVI_MEM0_DATA_DIR: path.join(dirs.data, 'Mem0', 'data'),
      YUVI_MEM0_LOG_DIR: path.join(dirs.data, 'Mem0', 'logs'),
      MEM0_BASE_URL: 'http://127.0.0.1:16131',
      SERVER_HOST: '127.0.0.1', SERVER_PORT: String(runtimePort), LOCAL_STT_BASE_URL: `http://127.0.0.1:${sttPort}`,
      LOCAL_TTS_BASE_URL: 'http://127.0.0.1:19881', GPT_SOVITS_TTS_BASE_URL: 'http://127.0.0.1:19881', GPT_SOVITS_TTS_UPSTREAM_URL: 'http://127.0.0.1:19880'
    };
    const node = path.join(root, 'runtime', 'node');
    const supervisor = spawn(node, [path.join(root, 'supervisor', 'yuvi-desktop-supervisor.cjs'), '--mode', 'packaged', '--resource-root', root, '--state-root', dirs.data, '--runtime-manifest', path.join(root, 'runtime', 'runtime-manifest.json')], { cwd: state, env, stdio: 'inherit' });
    expectedSupervisorPid = supervisor.pid;
    const desktopEnv = { ...env, YUVI_DESKTOP_SUPERVISOR_BINDING: 'attach' };
    // Opt-in native WebDriver/renderer settings affect only the desktop process.
    // They grant no identity or control-plane permission; consent remains native.
    for (const key of ['TAURI_WEBVIEW_AUTOMATION', 'WEBKIT_DISABLE_DMABUF_RENDERER', 'LIBGL_ALWAYS_SOFTWARE']) {
      if (process.env[key]) desktopEnv[key] = process.env[key];
    }
    if (process.env.TAURI_WEBVIEW_AUTOMATION === 'true' && /^127\.0\.0\.1:\d+$/.test(process.env.WEBKIT_INSPECTOR_SERVER || '')) {
      desktopEnv.WEBKIT_INSPECTOR_SERVER = process.env.WEBKIT_INSPECTOR_SERVER;
    }
    if (!process.env.GDK_BACKEND && guiSessionEnv.WAYLAND_DISPLAY && guiSessionEnv.DISPLAY) {
      desktopEnv.GDK_BACKEND = 'x11';
    } else if (process.env.GDK_BACKEND) {
      desktopEnv.GDK_BACKEND = process.env.GDK_BACKEND;
    }
    let web, desktop, closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      supervisor.kill('SIGTERM');
      web?.kill('SIGTERM');
      desktop?.kill('SIGTERM');
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    supervisor.once('error', stop);
    supervisor.once('exit', code => {
      closing = true;
      web?.kill('SIGTERM');
      desktop?.kill('SIGTERM');
      process.exitCode = process.exitCode || code || 0;
    });

    // A9: the Supervisor first publishes only its authenticated control plane.
    // Tauri must start next because its platform SecretStore owns the private-PG password.
    const controlDeadline = Date.now() + 25_000;
    while (!closing) {
      try {
        await control('/v1/status');
        break;
      } catch (error) {
        // Wait only for the authenticated control plane of our child.
      }
      if (Date.now() >= controlDeadline) { stop(); throw new Error('Supervisor control plane did not become ready.'); }
      await new Promise(r => setTimeout(r, 250));
    }

    if (!closing) {
      desktop = spawn(desktopShell, [], { cwd: state, env: desktopEnv, stdio: 'inherit' });
      desktop.once('error', stop); desktop.once('exit', stop);
    }

    // Desktop sequences bootstrap; Supervisor owns service readiness and failure.
    // Static presentation can start immediately and consumes that ownership truth.
    if (!closing) {
      web = spawn(node, [path.join(root, 'web', 'static-server.mjs'), '--root', path.join(root, 'web', 'dist'), '--port', String(webPort), '--runtime-port', String(runtimePort)], { cwd: state, env: { ...env, YUVI_EXPECTED_SUPERVISOR_PID: String(expectedSupervisorPid) }, stdio: 'inherit' });
      web.once('error', stop); web.once('exit', stop);
      console.log(`YUVI desktop shell started. Browser fallback: http://127.0.0.1:${webPort}/#/webui\nRun ./yuvi stop to shut down.`);
    }
  } else throw new Error('Usage: ./yuvi [start|stop|status|prepare-backup|review-recovery /absolute/clearance.json|cubism-core]');
} catch (error) { console.error(error.message); process.exitCode = 1; }
