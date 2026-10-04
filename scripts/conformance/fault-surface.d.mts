import type { ChildProcess } from "node:child_process";
export const FAULT_POINTS: readonly string[];
export class InjectedFault extends Error { point: string; constructor(point: string); }
export class FaultPlan {
  trace: string[];
  arm(point: string, action?: "THROW" | "PAUSE" | "IPC"): { ready: Promise<void>; release(): void };
  hit(point: string): Promise<void>;
  around<T>(point: string, forward: () => Promise<T>): Promise<T>;
}
export function faultPort<T extends object>(owner: T, methods: Partial<Record<keyof T, string>>, faults: FaultPlan): T;
export function faultPool<T extends object>(pool: T, faults: FaultPlan, identify: (sql: string) => string | null): T;
export type SurfaceInput = {
  kind: "PRIVATE" | "GROUP"; text: string; upstreamId?: string; principalHint?: string;
  audienceHint?: string; members?: string[];
};
export function surfaceInput(raw: unknown): Readonly<SurfaceInput>;
export class SyntheticSurface<T> {
  constructor(hostIngress: (input: Readonly<SurfaceInput>) => Promise<T>, faults?: FaultPlan);
  receive(raw: unknown): Promise<T>;
}
export class ControlledTarget {
  calls: Array<{ key: string; digest: string }>;
  capabilities: Readonly<{ idempotent: boolean; lookup: boolean }>;
  constructor(capabilities?: { idempotent?: boolean; lookup?: boolean });
  write(key: string, payload: string, response?: string): Promise<string>;
  lookup(key: string): string;
}
export function waitForCheckpoint(child: ChildProcess, expected: string, timeoutMs?: number): Promise<void>;
