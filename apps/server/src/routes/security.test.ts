import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";
import { hasLocalDashboardAccess } from "./security.js";

function request(ip: string, headers: Record<string, string> = {}) {
  return { ip, headers } as unknown as FastifyRequest;
}

describe("local dashboard dispatch authorization", () => {
  const config = {
    runtimeMode: "development",
    dashboardDevToken: "dispatch-secret"
  } as ServerConfig;

  it("rechecks localhost and the development token at dispatch", () => {
    expect(
      hasLocalDashboardAccess(
        config,
        request("127.0.0.1", {
          authorization: "Bearer dispatch-secret"
        })
      )
    ).toBe(true);
    expect(
      hasLocalDashboardAccess(
        config,
        request("192.0.2.9", {
          authorization: "Bearer dispatch-secret"
        })
      )
    ).toBe(false);
    expect(
      hasLocalDashboardAccess(
        config,
        request("127.0.0.1", {
          authorization: "Bearer expired-secret"
        })
      )
    ).toBe(false);
    expect(hasLocalDashboardAccess(config, request("127.0.0.1"))).toBe(false);
  });

  it("keeps local production controls independent of the development token", () => {
    expect(hasLocalDashboardAccess({ ...config, runtimeMode: "production" }, request("::1"))).toBe(
      true
    );
    expect(
      hasLocalDashboardAccess({ ...config, runtimeMode: "production" }, request("198.51.100.3"))
    ).toBe(false);
  });
});
