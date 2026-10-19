import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('cold recovery custody rejects tampering, missing review and concurrent activation', { skip: process.platform !== 'linux' }, () => {
  execFileSync('python3', [fileURLToPath(new URL('./cold-vm-recovery.test.py', import.meta.url))], { stdio: 'pipe' });
});
