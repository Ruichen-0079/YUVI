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

function hasDashboardDevTokenAccess(config: ServerConfig, request: FastifyRequest): boolean {
  if (config.runtimeMode !== "development" || !config.dashboardDevToken) return true;
  const provided = request.headers["x-yuvi-dev-token"];
  const legacyToken = Array.isArray(provided) ? provided[0] : provided;
  const authorization = request.headers.authorization;
  const authorizationValue = Array.isArray(authorization) ? authorization[0] : authorization;
  const bearerToken = authorizationValue?.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim();
  return (bearerToken ?? legacyToken) === config.dashboardDevToken;
}

export function isLocalAddress(value: string | undefined): boolean {
  return (
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1" ||
    value === "localhost"
  );
}
