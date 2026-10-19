import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

async function viWaitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`missing ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
import {
  SUPERVISOR_INSTANCE_LOCK_FILE,
  SupervisorInstanceLockError,
  acquireSupervisorInstanceLock
} from "./instance-lock.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-lock-"));
  tempDirs.push(dir);
  return dir;
}

describe("Supervisor instance lock", () => {
  it.skipIf(process.platform!=="linux")("retires boot/start-stale metadata without signalling the reused live PID", () => {
    const root=tempDir(),file=path.join(root,SUPERVISOR_INSTANCE_LOCK_FILE);
    const live=acquireSupervisorInstanceLock(root);const saved=JSON.parse(fs.readFileSync(file,"utf8"));live.release();
    for (const changed of [{...saved.linuxIdentity,startTicks:String(BigInt(saved.linuxIdentity.startTicks)+1n)}, {...saved.linuxIdentity,bootId:"previous-boot"}]) {
      fs.writeFileSync(file,JSON.stringify({...saved,linuxIdentity:changed}),{mode:0o600});
      const renewed=acquireSupervisorInstanceLock(root);
      expect(JSON.parse(fs.readFileSync(file,"utf8")).linuxIdentity).toEqual(saved.linuxIdentity);
      expect(process.kill(process.pid,0)).toBe(true);renewed.release();
    }
  });
  it("refuses a second competing owner while the holder is alive", async () => {
    const root = tempDir();
    const lockPath = path.join(root, SUPERVISOR_INSTANCE_LOCK_FILE);
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})+'\\n',{flag:'wx',mode:0o600}); setInterval(()=>{},1000)`
      ],
      { stdio: "ignore" }
    );
    const holderPid = holder.pid;
    expect(holderPid).toBeTruthy();
    try {
      await viWaitForFile(lockPath);
      expect(() => acquireSupervisorInstanceLock(root)).toThrow(SupervisorInstanceLockError);
      expect(() => acquireSupervisorInstanceLock(root)).toThrow(/already running/i);
      const stored = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number };
      expect(stored.pid).toBe(holderPid);
    } finally {
      holder.kill("SIGKILL");
      await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    }
  });

  it("recovers stale dead-instance lock state", () => {
    const root = tempDir();
    const lockPath = path.join(root, SUPERVISOR_INSTANCE_LOCK_FILE);
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 999_999_999, startedAt: "2020-01-01T00:00:00.000Z" })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    const lock = acquireSupervisorInstanceLock(root);
    const stored = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number };
    expect(stored.pid).toBe(process.pid);
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not steal a genuinely live foreign holder", async () => {
    const root = tempDir();
    const lockPath = path.join(root, SUPERVISOR_INSTANCE_LOCK_FILE);
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore"
    });
    const holderPid = holder.pid;
    expect(holderPid).toBeTruthy();
    try {
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: holderPid, startedAt: new Date().toISOString() })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
      expect(() => acquireSupervisorInstanceLock(root)).toThrow(/already running/i);
      const stored = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number };
      expect(stored.pid).toBe(holderPid);
    } finally {
      holder.kill("SIGKILL");
      await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    }
  });
});
