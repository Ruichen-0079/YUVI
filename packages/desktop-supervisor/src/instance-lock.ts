import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isProcessAlive } from "./process-windows.js";

export const SUPERVISOR_INSTANCE_LOCK_FILE = "supervisor.instance.lock";

export class SupervisorInstanceLockError extends Error {
  readonly holderPid: number | null;

  constructor(message: string, holderPid: number | null = null) {
    super(message);
    this.name = "SupervisorInstanceLockError";
    this.holderPid = holderPid;
  }
}

export type SupervisorInstanceLock = {
  lockPath: string;
  release: () => void;
};

function linuxIdentity(pid: number): { bootId: string; startTicks: string } {
  const bootId=fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim();
  const stat=fs.readFileSync(`/proc/${pid}/stat`,"utf8");
  const startTicks=stat.slice(stat.lastIndexOf(") ")+2).split(" ")[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) throw Error("Kernel process start identity unavailable");
  return {bootId,startTicks};
}

/**
 * Exclusive lock under the shared DesktopSupervisor pointer root so one
 * desktop owner cannot silently start a second competing Supervisor.
 * Stale dead-pid files are recovered; a live foreign holder is not stolen.
 */
export function acquireSupervisorInstanceLock(pointerRoot: string): SupervisorInstanceLock {
  fs.mkdirSync(pointerRoot, { recursive: true });
  const lockPath = path.join(pointerRoot, SUPERVISOR_INSTANCE_LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // Publish an already complete record atomically. An empty wx-created
      // target must never be mistaken for a stale owner by another claimant.
      const temp=path.join(pointerRoot,`.supervisor-lock-${randomUUID()}.tmp`);
      try {
        const fd=fs.openSync(temp,"wx",0o600);
        try {
          fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),...(process.platform==="linux"?{linuxIdentity:linuxIdentity(process.pid)}:{})})+"\n");
          fs.fsyncSync(fd);
        } finally {fs.closeSync(fd);}
        fs.linkSync(temp,lockPath);
      } finally {try{fs.unlinkSync(temp);}catch{}}

      return { lockPath, release: () => releaseLockFile(lockPath, process.pid) };
    } catch (error) {
      if (error instanceof SupervisorInstanceLockError) throw error;
      if ((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
      let stale = false;
      try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const data = JSON.parse(raw) as { pid?: unknown; linuxIdentity?: {bootId?:unknown;startTicks?:unknown} };
        const holder = Number(data?.pid);
        if (!Number.isInteger(holder) || holder <= 0) {
          throw new SupervisorInstanceLockError("Another Supervisor may already be running; lock identity is incomplete. No automatic claim.");
        } else if (!isProcessAlive(holder)) {
          stale = true;
        } else if (process.platform==="linux" && data.linuxIdentity) {
          const saved=data.linuxIdentity;
          if (typeof saved.bootId!=="string" || typeof saved.startTicks!=="string") throw new SupervisorInstanceLockError("Malformed kernel lock identity; no process or lock was reclaimed.",holder);
          let live;
          try {live=linuxIdentity(holder);} catch {throw new SupervisorInstanceLockError("Kernel lock identity unavailable; no process or lock was reclaimed.",holder);}
          if (saved.bootId!==live.bootId || saved.startTicks!==live.startTicks) stale=true;
          else if (holder===process.pid) return {lockPath,release:()=>releaseLockFile(lockPath,process.pid)};
          else throw new SupervisorInstanceLockError(`Another YUVI Supervisor is already running (kernel identity, pid ${holder}).`,holder);
        } else if (holder === process.pid) {
          return { lockPath, release: () => releaseLockFile(lockPath, process.pid) };
        } else {
          throw new SupervisorInstanceLockError(
            `Another YUVI Supervisor is already running (pid ${holder}). Close other YUVI windows/installs, then retry.`,
            holder
          );
        }
      } catch (inner) {
        if (inner instanceof SupervisorInstanceLockError) throw inner;
        throw new SupervisorInstanceLockError("Another Supervisor may already be running; lock metadata is unreadable or incomplete. No automatic claim.");
      }
      if (stale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // retry wx create
        }
      }
    }
  }
  throw new SupervisorInstanceLockError("Unable to acquire Supervisor instance lock.");
}

function releaseLockFile(lockPath: string, pid: number): void {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const data = JSON.parse(raw) as { pid?: unknown; linuxIdentity?: {bootId?:unknown;startTicks?:unknown} };
    if (data?.pid === pid) fs.unlinkSync(lockPath);
  } catch {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}
