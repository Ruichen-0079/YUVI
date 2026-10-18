import { MemoryKnowledgeClient } from "@companion/memory/knowledge-client";
import { resolveApiBaseUrl } from "./desktop-runtime.js";
export type ProductHostState = {
  schema: "host.product.v1";
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  personId: string;
  personaId: string;
  memoryEnabled: boolean;
  expiresAt: string;
  renewalUntil: string;
};
export class ProductMemoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}
export async function productRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(resolveApiBaseUrl() + path, {
    credentials: "include",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        })
  });
  const result = await response.json();
  if (!response.ok)
    throw new ProductMemoryError(
      response.status,
      typeof result.error === "string" ? result.error : "MEMORY_UNAVAILABLE"
    );
  return result as T;
}
export const knowledgeClient = new MemoryKnowledgeClient(productRequest);
export const productMemoryScope = (host: ProductHostState) =>
  `yuvi:v1:user:${encodeURIComponent(host.personId)}:character:${encodeURIComponent(host.personaId)}`;
export function notifyProductHost(personId: string | null, personaId?: string) {
  personId = personId && personaId ? JSON.stringify([personaId, personId]) : personId;
  if (localStorage.getItem("yuvi.product-host-person") === personId) return;
  if (personId) localStorage.setItem("yuvi.product-host-person", personId);
  else localStorage.removeItem("yuvi.product-host-person");
  window.dispatchEvent(new Event("yuvi-product-host-changed"));
}
