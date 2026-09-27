import Fastify from "fastify";
import { JournalStoreError } from "@companion/journal";
import {
  AssistantTurnConflictError,
  ProactiveAdmissionError,
  type RuntimeReplyStreamEvent
} from "@companion/core";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { describe, expect, it, vi } from "vitest";
import { registerProactiveTurnStreamRoutes } from "./proactive-turn-stream.js";
import type { ProactiveTurnReceiptInput } from "../proactive-turn-receipt-admission.js";

function runtimeFor(
  streamAssistantInitiatedTurn: AppContext["runtime"]["streamAssistantInitiatedTurn"]
): AppContext {
  return { runtime: { streamAssistantInitiatedTurn } } as unknown as AppContext;
}

async function createTestApp(context: AppContext) {
  const app = Fastify({ logger: false });
  await registerProactiveTurnStreamRoutes(
    app,
    {
      ...context,
      proactiveTurnReceiptAdmission: context.proactiveTurnReceiptAdmission ?? { async admit() {} }
    } as AppContext,
    {
      runtimeMode: "test",
      dashboardDevToken: undefined
    } as unknown as ServerConfig
  );
  return app;
}

describe("proactive turn SSE route", () => {
  it("accepts only the strict assistant-origin DTO and streams existing SSE events", async () => {
    let receivedInput: unknown;
    const order: string[] = [];
    const runtimeMethod = vi.fn((input: unknown) => {
      order.push("runtime-created");
      return (async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
        order.push("runtime-advanced");
        receivedInput = input;
        yield {
          type: "proactive-decision",
          decision: "REQUEST_TEXT",
          sessionId: "session-1",
          traceId: "trace-1"
        };
        yield {
          type: "text-delta",
          text: "hello",
          messageId: "assistant-1",
          sessionId: "session-1",
          traceId: "trace-1"
        };
        yield {
          type: "completed",
          messageId: "assistant-1",
          sessionId: "session-1",
          traceId: "trace-1",
          content: "hello",
          provider: "mock"
        };
      })();
    });
    const app = await createTestApp({
      runtime: { streamAssistantInitiatedTurn: runtimeMethod },
      proactiveTurnReceiptAdmission: {
        async admit(input: ProactiveTurnReceiptInput) {
          order.push("journal");
          expect(input).toEqual({
            sessionId: "session-1",
            readMemory: false,
            promptPreview: true
          });
        }
      }
    } as unknown as AppContext);

    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-1",
        idempotencyKey: "decision-1",
        modality: "text",
        options: { readMemory: false, promptPreview: true }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: proactive-decision");
    expect(response.body).toContain("event: text-delta");
    expect(response.body).toContain("event: completed");
    expect(receivedInput).toEqual({
      sessionId: "session-1",
      idempotencyKey: "decision-1",
      readMemory: false
    });
    expect(order).toEqual(["journal", "runtime-created", "runtime-advanced"]);
    await app.close();
  });

  it("rejects a remote caller before Journal admission", async () => {
    let admissions = 0;
    let runtimeCalls = 0;
    const app = await createTestApp({
      runtime: {
        streamAssistantInitiatedTurn: async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
          runtimeCalls += 1;
        }
      },
      proactiveTurnReceiptAdmission: {
        async admit() {
          admissions += 1;
        }
      }
    } as unknown as AppContext);
    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      remoteAddress: "203.0.113.17",
      payload: {
        sessionId: "remote-session",
        idempotencyKey: "remote-key",
        modality: "text",
        options: { readMemory: false }
      }
    });
    expect(response.statusCode).toBe(403);
    expect(admissions).toBe(0);
    expect(runtimeCalls).toBe(0);
    await app.close();
  });

  it("rejects invalid requests before Journal admission", async () => {
    let admissions = 0;
    const app = await createTestApp({
      runtime: { streamAssistantInitiatedTurn: async function* () {} },
      proactiveTurnReceiptAdmission: {
        async admit() {
          admissions += 1;
        }
      }
    } as unknown as AppContext);
    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-1",
        idempotencyKey: "invalid",
        modality: "text",
        options: { readMemory: false },
        unexpected: true
      }
    });
    expect(response.statusCode).toBe(400);
    expect(admissions).toBe(0);
    await app.close();
  });

  it("bounds persisted session correlations and Runtime claim keys before admission", async () => {
    let admissions = 0;
    const app = await createTestApp({
      runtime: { streamAssistantInitiatedTurn: async function* () {} },
      proactiveTurnReceiptAdmission: {
        async admit() {
          admissions += 1;
        }
      }
    } as unknown as AppContext);
    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-1",
        idempotencyKey: "k".repeat(513),
        modality: "text",
        options: { readMemory: false }
      }
    });
    expect(response.statusCode).toBe(400);
    expect(admissions).toBe(0);
    await app.close();
  });

  it("fails closed on Journal errors without starting Runtime or SSE", async () => {
    let runtimeCalls = 0;
    const app = await createTestApp({
      runtime: {
        streamAssistantInitiatedTurn: async function* () {
          runtimeCalls += 1;
        }
      },
      proactiveTurnReceiptAdmission: {
        async admit() {
          throw new JournalStoreError("DATABASE_UNAVAILABLE", "private database detail");
        }
      }
    } as unknown as AppContext);
    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-1",
        idempotencyKey: "journal-down",
        modality: "text",
        options: { readMemory: false }
      }
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).not.toContain("text/event-stream");
    expect(response.body).not.toContain("private database detail");
    expect(runtimeCalls).toBe(0);
    await app.close();
  });

  it("ends a successful NO_OP stream without a completed assistant event", async () => {
    const app = await createTestApp(
      runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
        yield {
          type: "proactive-decision",
          decision: "NO_OP",
          sessionId: "session-no-op",
          traceId: "trace-no-op"
        };
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-no-op",
        idempotencyKey: "decision-no-op",
        modality: "text",
        options: { readMemory: false }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: proactive-decision");
    expect(response.body).not.toContain("event: completed");
    expect(response.body).not.toContain("event: error");
    await app.close();
  });

  it("maps an invalid Runtime proactive sequence through the SSE error path", async () => {
    const app = await createTestApp(
      runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
        yield {
          type: "text-delta",
          text: "unexpected",
          messageId: "assistant-invalid",
          sessionId: "session-invalid",
          traceId: "trace-invalid"
        };
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-invalid",
        idempotencyKey: "decision-invalid-sequence",
        modality: "text",
        options: { readMemory: false }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: error");
    expect(response.body).toContain('"code":"INTERNAL"');
    await app.close();
  });

  it.each([{ text: "hidden" }, { writeMemory: true }, { modality: "speech" }, { unknown: true }])(
    "rejects malformed or out-of-contract fields: %o",
    async (extra) => {
      let calls = 0;
      const app = await createTestApp(
        runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
          calls += 1;
          yield {
            type: "completed",
            messageId: "assistant-1",
            sessionId: "session-1",
            traceId: "trace-1",
            content: "should not run",
            provider: "mock"
          };
        })
      );

      const response = await app.inject({
        method: "POST",
        url: "/v1/proactive-turns/stream",
        payload: {
          sessionId: "session-1",
          idempotencyKey: "decision-invalid",
          modality: "text",
          options: { readMemory: false },
          ...extra
        }
      });

      expect(response.statusCode).toBe(400);
      expect(calls).toBe(0);
      await app.close();
    }
  );

  it("maps a duplicate Runtime claim to a pre-stream conflict", async () => {
    const app = await createTestApp(
      runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
        throw new AssistantTurnConflictError("decision-duplicate");
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-1",
        idempotencyKey: "decision-duplicate",
        modality: "text",
        options: { readMemory: false }
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "idempotency_conflict" });
    expect(response.headers["content-type"]).not.toContain("text/event-stream");
    await app.close();
  });

  it("rejects writeMemory even when nested under the strict options object", async () => {
    let calls = 0;
    const app = await createTestApp(
      runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
        calls += 1;
        yield {
          type: "completed",
          messageId: "assistant-1",
          sessionId: "session-1",
          traceId: "trace-1",
          content: "should not run",
          provider: "mock"
        };
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-1",
        idempotencyKey: "decision-write",
        modality: "text",
        options: { readMemory: false, writeMemory: true }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(calls).toBe(0);
    await app.close();
  });

  it("maps Runtime admission denial before P6 execution", async () => {
    const app = await createTestApp(
      runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
        throw new ProactiveAdmissionError("suppressed");
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: {
        sessionId: "session-1",
        idempotencyKey: "denied",
        modality: "text",
        options: { readMemory: false }
      }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "proactive_not_admitted",
      reason: "suppressed"
    });
    await app.close();
  });

  it("journals a READY settings projection before applying Runtime consent", async () => {
    const order: string[] = [];
    let applied: unknown;
    const app = await createTestApp({
      runtime: {
        streamAssistantInitiatedTurn: async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
          throw new Error("must not run");
        },
        preflightProactiveConsentProjection: () => ({ result: "APPLY" }),
        applyProactiveConsentProjection(value: unknown) {
          order.push("apply");
          applied = value;
          return "APPLIED";
        }
      },
      proactiveConsentReceiptAdmission: {
        async admit(value: unknown) {
          order.push("journal");
          expect(value).toEqual({ enabled: true, settingsRevision: 42 });
        }
      }
    } as unknown as AppContext);
    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      payload: { state: "READY", revision: 42, enabled: true }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, applied: true, state: "READY" });
    expect(order).toEqual(["journal", "apply"]);
    expect(applied).toEqual({ state: "READY", revision: 42, enabled: true });
    await app.close();
  });

  it("applies UNKNOWN_DENIED immediately without Journal admission", async () => {
    const order: string[] = [];
    const app = await createTestApp({
      runtime: {
        streamAssistantInitiatedTurn: async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
          throw new Error("must not run");
        },
        invalidateProactiveConsentProjection(revisionFloor: number) {
          order.push(`invalidate:${revisionFloor}`);
          return "APPLIED";
        }
      },
      proactiveConsentReceiptAdmission: {
        async admit() {
          order.push("journal");
        }
      }
    } as unknown as AppContext);
    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      payload: { state: "UNKNOWN_DENIED", revisionFloor: 43 }
    });
    expect(response.statusCode).toBe(200);
    expect(order).toEqual(["invalidate:43"]);
    await app.close();
  });

  it("rejects the legacy boolean projection before touching Runtime or Journal", async () => {
    const app = await createTestApp({
      runtime: { streamAssistantInitiatedTurn: async function* () {} },
      proactiveConsentReceiptAdmission: {
        async admit() {
          throw new Error("must not run");
        }
      }
    } as unknown as AppContext);
    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      payload: { enabled: true }
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("does not apply READY when durable Journal admission fails", async () => {
    let applied = false;
    const app = await createTestApp({
      runtime: {
        streamAssistantInitiatedTurn: async function* () {},
        preflightProactiveConsentProjection: () => ({ result: "APPLY" }),
        applyProactiveConsentProjection() {
          applied = true;
          return "APPLIED";
        }
      },
      proactiveConsentReceiptAdmission: {
        async admit() {
          throw new JournalStoreError("DATABASE_UNAVAILABLE", "private database detail");
        }
      }
    } as unknown as AppContext);
    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      payload: { state: "READY", revision: 1, enabled: true }
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private database detail");
    expect(applied).toBe(false);
    await app.close();
  });
});
