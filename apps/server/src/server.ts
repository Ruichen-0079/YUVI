import { registerConversationHistoryRoutes } from "./routes/conversation-history.js";
import { registerPeopleVoiceRoutes } from "./routes/people-voices.js";
import { registerProductRoutes } from "./routes/product.js";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { ServerConfig } from "./config.js";
import { createAppContext } from "./context.js";
import { registerDebugRoutes } from "./routes/debug.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerLocalServiceRoutes } from "./routes/local-services.js";
import { registerLocalConnectionRoutes } from "./routes/local-connection.js";
import { memorySearchValidationError, registerMemoryRoutes } from "./routes/memory.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerSpeechActivityRoutes } from "./routes/speech-activity.js";
import { registerMessageRoutes } from "./routes/message.js";
import { registerMessageStreamRoutes } from "./routes/message-stream.js";
import { registerProactiveTurnStreamRoutes } from "./routes/proactive-turn-stream.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerEventRoutes } from "./routes/events.js";
import { MemoryMaintenanceScheduler } from "./services/memoryMaintenanceScheduler.js";
import { registerWebSocketRoutes } from "./routes/websocket.js";
import { registerLive2DCoreRoute, registerLive2DRoutes } from "./routes/live2d.js";
import { registerEmbodiedPresentationRoutes } from "./routes/embodied-presentation.js";
import { desktopCorsHeaders } from "./cors.js";
import {
  SERVER_PLUGIN_OPERATION_TIMEOUT_MS,
  ServerPluginLifecycle,
  type ServerPluginSourceDiscovery
} from "./plugin-lifecycle.js";
import type { ServerPluginCapabilityGrant } from "./mcp-capability-binding.js";

export type BuildServerOptions = Readonly<{
  /** Composition-time source registration; discovery does not call source loaders. */
  discoverPlugins?: ServerPluginSourceDiscovery | undefined;
  /** Host-authored grants; plugin declarations cannot create or alter these. */
  pluginCapabilityGrants?: readonly ServerPluginCapabilityGrant[] | undefined;
}>;

export async function buildServer(config: ServerConfig, options: BuildServerOptions = {}) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.apiKey",
        "*.authorization",
        "*.Authorization"
      ]
    }
  });

  const pluginLifecycle = new ServerPluginLifecycle(
    options.discoverPlugins ?? (() => []),
    app.log,
    SERVER_PLUGIN_OPERATION_TIMEOUT_MS,
    options.pluginCapabilityGrants ?? []
  );
  app.addHook("onReady", async () => {
    await pluginLifecycle.discover();
    await pluginLifecycle.load();
    await pluginLifecycle.start();
  });

  app.setErrorHandler((error, request, reply) => {
    const normalizedError = normalizeError(error);
    const requestUrl = request.raw.url ?? "";
    if (requestUrl.startsWith("/memory/search") && isMalformedQueryError(normalizedError)) {
      return reply.status(400).send(memorySearchValidationError());
    }

    const statusCode =
      normalizedError.statusCode && normalizedError.statusCode >= 400
        ? normalizedError.statusCode
        : 500;
    if (statusCode >= 500) {
      request.log.error({ err: normalizedError }, "request failed");
    }
    return reply.status(statusCode).send({
      error: statusCode >= 500 ? "internal_server_error" : "bad_request",
      message: normalizedError.message
    });
  });

  await app.register(websocket);

  // Tauri desktop webview (tauri.localhost) calls Runtime on 127.0.0.1 — needs CORS.
  app.addHook("onRequest", async (request, reply) => {
    for (const [name, value] of Object.entries(desktopCorsHeaders(request.headers.origin))) {
      reply.header(name, value);
    }
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  if (config.runtimeMode === "development" && config.host === "0.0.0.0") {
    app.log.warn(
      "SERVER_HOST=0.0.0.0 exposes the development server on the local network. Use 127.0.0.1 unless you intentionally need LAN access."
    );
  }
  if (config.dashboardDevToken) {
    app.log.info("DASHBOARD_DEV_TOKEN is configured for sensitive development endpoints.");
  }

  const context = await createAppContext(app.log, config, pluginLifecycle.runtimeCapabilities);
  try {
    const recovered = await context.runtime.recoverStaleStreamingMessages({
      limit: config.memoryMaintenance.limit
    });
    if (recovered.length > 0) {
      app.log.warn(
        { recoveredCount: recovered.length },
        "recovered stale streaming conversation messages at startup"
      );
    }
  } catch (error) {
    app.log.warn(
      { err: error },
      "stale streaming conversation recovery was unavailable at startup"
    );
  }
  const maintenanceScheduler = new MemoryMaintenanceScheduler(context, config, app.log);
  context.memoryMaintenanceScheduler = maintenanceScheduler;
  maintenanceScheduler.start();
  if (config.memoryIngestion.enabled) {
    context.memoryIngestionCoordinator.start();
  }

  app.addHook("onClose", async () => {
    await pluginLifecycle.shutdown();
    maintenanceScheduler.close();
    context.embodiedPresentationBridge.close();
    await context.memoryIngestionCoordinator.shutdown({ graceMs: 2_000 });
    await context.runtime.sealAndDrainMemoryWrites();
    await context.finalizedIngestionRepository.close?.();
    await context.memoryRepository.close?.();
    await context.conversationRepository.close?.();
  });

  await registerHealthRoutes(app, context, config);
  await registerLocalServiceRoutes(app, context, config);
  await registerLocalConnectionRoutes(app, context, config);
  await registerProviderRoutes(app, context, config);
  await registerSettingsRoutes(app, context, config);
  await registerProductRoutes(app, context, config);
  await registerPeopleVoiceRoutes(app, context, config);
  await registerSystemRoutes(app, config);
  await registerMessageRoutes(app, context);
  await registerConversationHistoryRoutes(app, context);
  await registerMessageStreamRoutes(app, context);
  await registerProactiveTurnStreamRoutes(app, context);
  await registerMediaRoutes(app, context);
  await registerSpeechActivityRoutes(app, context);
  await registerMemoryRoutes(app, context, config);
  await registerEventRoutes(app, context);
  await registerDebugRoutes(app, context, config);
  await registerWebSocketRoutes(app, context);
  await registerLive2DRoutes(app, config);
  await registerEmbodiedPresentationRoutes(app, context);
  await registerLive2DCoreRoute(app, config);

  return app;
}

function normalizeError(error: unknown): Error & { statusCode?: number } {
  if (error instanceof Error) {
    return error as Error & { statusCode?: number };
  }
  return new Error("Unknown request error.");
}

function isMalformedQueryError(error: Error & { statusCode?: number }): boolean {
  const message = error.message.toLowerCase();
  return (
    error.statusCode === 400 &&
    (message.includes("uri") ||
      message.includes("url") ||
      message.includes("malformed") ||
      message.includes("invalid"))
  );
}
