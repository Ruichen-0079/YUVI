import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";

export function requireDashboardDevToken(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply
): boolean {
  if (hasDashboardDevTokenAccess(config, request)) {
    return true;
  }

  reply.status(401).send({
    error: "unauthorized",
    message: "A valid Authorization: Bearer token is required for this development endpoint."
  });
  return false;
}

export function requireLocalDashboardAccess(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply
): boolean {
  if (!isLocalAddress(request.ip)) {
    reply.status(403).send({
      error: "forbidden",
      message: "This dashboard operation can only be requested from localhost."
    });
    return false;
  }

  return requireDashboardDevToken(config, request, reply);
}

/** Re-evaluate local dashboard permission at a durable command's dispatch boundary. */
export function hasLocalDashboardAccess(config: ServerConfig, request: FastifyRequest): boolean {
  return isLocalAddress(request.ip) && hasDashboardDevTokenAccess(config, request);
}

/** Browser WebSockets cannot set Authorization; credentials stay out of query URLs. */
export function hasLocalDashboardWebSocketAccess(
  config: ServerConfig,
  request: FastifyRequest
): boolean {
  const raw = request.headers["sec-websocket-protocol"];
  const protocols = (Array.isArray(raw) ? raw.join(",") : (raw ?? ""))
    .split(",")
    .map((value) => value.trim());
  const credentials = protocols.filter((value) => value.startsWith("yuvi-dev-token."));
  let token: string | undefined;
  if (credentials.length === 1) {
    const encoded = credentials[0]!.slice("yuvi-dev-token.".length);
    if (encoded.length <= 4096 && /^[A-Za-z0-9_-]+$/u.test(encoded)) {
      const decoded = Buffer.from(encoded, "base64url");
      if (decoded.toString("base64url") === encoded) token = decoded.toString("utf8");
    }
  }
  return isLocalAddress(request.ip) && hasDashboardDevTokenAccess(config, request, token);
}

function hasDashboardDevTokenAccess(
  config: ServerConfig,
  request: FastifyRequest,
  alternativeToken?: string
): boolean {
  if (config.runtimeMode !== "development" || !config.dashboardDevToken) return true;
  const provided = request.headers["x-yuvi-dev-token"];
  const legacyToken = Array.isArray(provided) ? provided[0] : provided;
  const authorization = request.headers.authorization;
  const authorizationValue = Array.isArray(authorization) ? authorization[0] : authorization;
  const bearerToken = authorizationValue?.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim();
  return (bearerToken ?? legacyToken ?? alternativeToken) === config.dashboardDevToken;
}

export function isLocalAddress(value: string | undefined): boolean {
  return (
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1" ||
    value === "localhost"
  );
}
