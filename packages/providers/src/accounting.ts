import { witnessedProviderCall, witnessedProviderStream } from "./invocation-witness.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

export type ProviderWorkContext = {
  scope: string;
  operationKey?: string | undefined;
  speechPlan?: "NONE" | "CLIENT_SEGMENTED" | "SERVER_WHOLE" | undefined;
  speechRequestId?: string | undefined;
  cause?: { kind: "JOURNAL_EVENT"; namespace: string; eventId: string } | undefined;
  executionId?: string | undefined;
  replyId?: string | undefined;
  isCurrent?: (() => boolean) | undefined;
};
export type ProviderTaskDescriptor = {
  operationId: string;
  operation: string;
  inputDigest: string;
  configurationRef: string;
  routingPlan: { provider: string; model: string | null }[];
  context: ProviderWorkContext | undefined;
};
export type ProviderLeafDescriptor = { provider: string; model: string | null; method: string };
/** Host implementation owns A9. Registry continues to own routing and concrete leaves. */
export interface ProviderAccountingPort {
  invoke<T>(
    task: ProviderTaskDescriptor,
    leaf: ProviderLeafDescriptor,
    call: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T>;
  stream<T>(
    task: ProviderTaskDescriptor,
    leaf: ProviderLeafDescriptor,
    call: (signal?: AbortSignal) => AsyncIterable<T>,
    signal?: AbortSignal
  ): AsyncIterable<T>;
}
const contexts = new AsyncLocalStorage<ProviderWorkContext>();
const tasks = new AsyncLocalStorage<ProviderTaskDescriptor>();
export function withProviderWorkContext<T>(context: ProviderWorkContext, call: () => T): T {
  return contexts.run(context, call);
}
export function providerInputDigest(input: unknown): string {
  // Private digest only. Inputs are not retained by the accounting layer.
  return createHash("sha256")
    .update(JSON.stringify(input ?? null))
    .digest("hex");
}
const effectMethods = new Set([
  "generateReply",
  "generateReasoning",
  "synthesizeSpeech",
  "transcribeAudio",
  "detectVoiceActivity",
  "analyzeImage",
  "embedText",
  "embedBatch",
  "decide",
  "generateContinuation",
  "streamReply"
]);
function taskFor(
  operation: string,
  args: unknown[],
  configurationRef: string,
  routingPlan: ProviderTaskDescriptor["routingPlan"]
): ProviderTaskDescriptor {
  return {
    operationId: contexts.getStore()?.operationKey ?? randomUUID(),
    operation,
    inputDigest: providerInputDigest(args[0]),
    configurationRef,
    routingPlan,
    context: contexts.getStore()
  };
}
function signalIn(args: unknown[]): AbortSignal | undefined {
  return (args[1] as { signal?: AbortSignal } | undefined)?.signal;
}
/** Scope the complete public operation, so certified fallback leaves share one logical task. */
export function scopeProviderTask<T>(
  provider: T,
  configurationRef: string,
  routingPlan: ProviderTaskDescriptor["routingPlan"]
): T {
  return new Proxy(provider as object, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (!effectMethods.has(String(key))) return value.bind(target);
      if (key === "streamReply")
        return async function* (...args: unknown[]) {
          const task =
            tasks.getStore() ?? taskFor(String(key), args, configurationRef, routingPlan);
          const iterator = tasks.run(task, () => value.apply(target, args)[Symbol.asyncIterator]());
          try {
            while (true) {
              const next = await tasks.run(task, () => iterator.next());
              if (next.done) return;
              yield next.value;
            }
          } finally {
            await tasks.run(task, () => iterator.return?.());
          }
        };
      return (...args: unknown[]) =>
        tasks.run(
          tasks.getStore() ?? taskFor(String(key), args, configurationRef, routingPlan),
          () => value.apply(target, args)
        );
    }
  }) as T;
}
/** Installed on actual leaves, inside every fallback chain; health checks remain operational. */
export function accountProviderLeaf<T>(
  provider: T,
  accounting: () => ProviderAccountingPort | undefined,
  configurationRef: string,
  routingPlan: ProviderTaskDescriptor["routingPlan"]
): T {
  return new Proxy(provider as object, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (!effectMethods.has(String(key))) return value.bind(target);
      const leaf = {
        provider: String(Reflect.get(target, "name")),
        model: Reflect.get(target, "model") ?? null,
        method: String(key)
      };
      if (key === "streamReply")
        return async function* (...args: unknown[]) {
          const port = accounting();
          const task =
            tasks.getStore() ?? taskFor(String(key), args, configurationRef, routingPlan);
          yield* port
            ? port.stream(
                task,
                leaf,
                (signal?: AbortSignal) =>
                  witnessedProviderStream(() =>
                    value.apply(target, [
                      args[0],
                      { ...((args[1] as object) ?? {}), ...(signal ? { signal } : {}) }
                    ])
                  ),
                signalIn(args)
              )
            : value.apply(target, args);
        };
      return (...args: unknown[]) => {
        const port = accounting();
        const task = tasks.getStore() ?? taskFor(String(key), args, configurationRef, routingPlan);
        return port
          ? port.invoke(
              task,
              leaf,
              (signal?: AbortSignal) =>
                witnessedProviderCall(() =>
                  value.apply(target, [
                    args[0],
                    { ...((args[1] as object) ?? {}), ...(signal ? { signal } : {}) }
                  ])
                ),
              signalIn(args)
            )
          : value.apply(target, args);
      };
    }
  }) as T;
}

export async function* withProviderWorkStream<T>(
  context: ProviderWorkContext,
  stream: () => AsyncIterable<T>
): AsyncIterable<T> {
  const iterator = withProviderWorkContext(context, () => stream()[Symbol.asyncIterator]());
  try {
    while (true) {
      const next = await withProviderWorkContext(context, () => iterator.next());
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await withProviderWorkContext(context, () => iterator.return?.());
  }
}
export function currentProviderWorkContext(): ProviderWorkContext | undefined {
  return contexts.getStore();
}
