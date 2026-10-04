/** Test infrastructure only. Every durable/semantic decision stays in the supplied owner. */
import { createHash } from "node:crypto";

export const FAULT_POINTS = Object.freeze([
  "receipt",
  "manifest",
  "intent",
  "attempt",
  "dispatch-start",
  "external-effect",
  "observation",
  "publication",
  "callback",
  "owner-revision",
  "shutdown",
  "restart"
]);
export class InjectedFault extends Error {
  constructor(point) {
    super(`Injected fault: ${point}`);
    this.point = point;
  }
}
export class FaultPlan {
  #armed = new Map();
  trace = [];
  arm(point, action = "THROW") {
    if (this.#armed.has(point)) throw Error(`Already armed: ${point}`);
    let reached, release;
    const ready = new Promise((r) => {
      reached = r;
    });
    const gate = new Promise((r) => {
      release = r;
    });
    this.#armed.set(point, { action, reached, gate });
    return { ready, release };
  }
  async hit(point) {
    this.trace.push(point);
    const fault = this.#armed.get(point);
    if (!fault) return;
    this.#armed.delete(point); // one concrete response loss, never a retry decision
    fault.reached();
    if (fault.action === "PAUSE") await fault.gate;
    else if (fault.action === "IPC") {
      if (!process.send) throw Error("IPC fault requires a child process");
      process.send({ checkpoint: point });
      await new Promise(() => {});
    } else if (fault.action === "THROW") throw new InjectedFault(point);
    else throw Error(`Unsupported fault action: ${fault.action}`);
  }
  async around(point, forward) {
    await this.hit(`${point}.before`);
    const result = await forward();
    await this.hit(`${point}.after`);
    return result;
  }
}

/** Intercept actual owner calls; return values and errors are never reinterpreted. */
export function faultPort(owner, methods, faults) {
  return new Proxy(owner, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return methods[key]
        ? (...args) => faults.around(methods[key], () => value.apply(target, args))
        : value.bind(target);
    }
  });
}

/** Both direct queries and checked-out transactions use the same real connection. */
export function faultPool(pool, faults, identify) {
  const connection = (client) =>
    new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return (...args) => {
            const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
            const point = identify(String(sql).trim().toLowerCase());
            return point
              ? faults.around(point, () => target.query(...args))
              : target.query(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  const wrapped = connection(pool);
  return new Proxy(wrapped, {
    get(target, key) {
      return key === "connect"
        ? async () => connection(await pool.connect())
        : Reflect.get(target, key);
    }
  });
}

/** Bounded transport hints, not authenticated principal/membership/disclosure authority. */
export function surfaceInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Invalid surface input");
  const allowed = new Set([
    "kind",
    "upstreamId",
    "principalHint",
    "audienceHint",
    "members",
    "text"
  ]);
  if (Object.keys(raw).some((k) => !allowed.has(k)))
    throw Error("Surface cannot supply owner authority");
  if (!["PRIVATE", "GROUP"].includes(raw.kind)) throw Error("Unsupported surface kind");
  for (const key of ["upstreamId", "principalHint", "audienceHint"])
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || raw[key].length > 256))
      throw Error(`Invalid bounded ${key}`);
  if (typeof raw.text !== "string" || raw.text.length > 4096) throw Error("Invalid bounded text");
  if (
    raw.members !== undefined &&
    (!Array.isArray(raw.members) ||
      raw.members.length > 32 ||
      raw.members.some((v) => typeof v !== "string" || v.length > 256))
  )
    throw Error("Invalid membership hint");
  return Object.freeze(structuredClone(raw));
}
export class SyntheticSurface {
  constructor(hostIngress, faults = new FaultPlan()) {
    this.hostIngress = hostIngress;
    this.faults = faults;
  }
  receive(raw) {
    return this.faults.around("receipt", () => this.hostIngress(surfaceInput(raw)));
  }
}

/** Controlled external peer. It never admits work, builds context, or chooses retries. */
export class ControlledTarget {
  calls = [];
  #applied = new Map();
  constructor({ idempotent = false, lookup = false } = {}) {
    this.capabilities = Object.freeze({ idempotent, lookup });
  }
  async write(key, payload, response = "APPLIED") {
    if (
      !["PROVEN_NOT_APPLIED", "APPLIED", "UNKNOWN", "CONFLICT", "LOST_RESPONSE"].includes(response)
    )
      throw Error("Unsupported target response");
    const digest = createHash("sha256").update(payload).digest("hex");
    this.calls.push({ key, digest });
    const previous = this.#applied.get(key);
    if (this.capabilities.idempotent && previous && previous !== digest) return "CONFLICT";
    if (response === "APPLIED" || response === "LOST_RESPONSE") this.#applied.set(key, digest);
    if (response === "LOST_RESPONSE") throw new InjectedFault("external-effect.response");
    return response;
  }
  lookup(key) {
    if (!this.capabilities.lookup) return "UNKNOWN";
    return this.#applied.has(key) ? "APPLIED" : "PROVEN_NOT_APPLIED";
  }
}

/** Timeout is a failing test watchdog only, never evidence about an effect. */
export function waitForCheckpoint(child, expected, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const data = (b) => {
      stderr += b;
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", message);
      child.off("exit", exited);
      child.stderr?.off("data", data);
    };
    const message = (value) => {
      if (value?.checkpoint !== expected) return;
      cleanup();
      resolve();
    };
    const exited = (code) => {
      cleanup();
      reject(Error(`Worker exited ${code}: ${stderr}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      child.kill("SIGKILL");
      reject(Error(`Checkpoint watchdog: ${expected}: ${stderr}`));
    }, timeoutMs);
    child.stderr?.on("data", data);
    child.on("message", message);
    child.once("exit", exited);
  });
}
