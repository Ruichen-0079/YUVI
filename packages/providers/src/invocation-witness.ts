import { AsyncLocalStorage } from "node:async_hooks";
import { ProviderError, cloneProviderError, certifyProviderNotStarted } from "./types/errors.js";
type Witness = { started: boolean; bodyReturned: boolean };
const active = new AsyncLocalStorage<Witness>();
const returnedBodyErrors = new WeakSet<object>();
export function isProviderResponseObservedError(error: unknown): boolean {
  return typeof error === "object" && error !== null && returnedBodyErrors.has(error);
}
/** Trusted transport boundary, installed on every production provider HTTP leaf. */
export async function providerFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1]
): Promise<Response> {
  const witness = active.getStore();
  if (witness) {
    witness.started = true;
    witness.bodyReturned = false;
  }
  const response = await globalThis.fetch(input, init);
  if (!witness) return response;
  return new Proxy(response, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (
        ["json", "text", "arrayBuffer", "blob", "formData", "bytes"].includes(String(key)) &&
        typeof value === "function"
      )
        return async (...args: unknown[]) => {
          if (key === "json" && typeof target.text === "function") {
            const text = await target.text();
            witness.bodyReturned = true;
            return JSON.parse(text);
          }
          const result = await value.apply(target, args);
          witness.bodyReturned = true;
          return result;
        };
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
/** A flag/status alone cannot certify either pre-transport non-start or a returned body. */
export function witnessedProviderCall<T>(call: () => Promise<T>): Promise<T> {
  const witness: Witness = { started: false, bodyReturned: false };
  return active.run(witness, async () => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ProviderError && !witness.started)
        throw certifyProviderNotStarted(cloneProviderError(error, { effectState: "not_started" }));
      if (witness.bodyReturned && error && typeof error === "object") returnedBodyErrors.add(error);
      throw error;
    }
  });
}
export async function* witnessedProviderStream<T>(call: () => AsyncIterable<T>): AsyncIterable<T> {
  const witness: Witness = { started: false, bodyReturned: false },
    iterator = active.run(witness, () => call()[Symbol.asyncIterator]());
  try {
    while (true) {
      const next = await active.run(witness, () => iterator.next());
      if (next.done) return;
      yield next.value;
    }
  } catch (error) {
    if (error instanceof ProviderError && !witness.started)
      throw certifyProviderNotStarted(cloneProviderError(error, { effectState: "not_started" }));
    throw error;
  } finally {
    await active.run(witness, () => iterator.return?.());
  }
}
