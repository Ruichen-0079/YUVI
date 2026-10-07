import type { FastifyInstance } from "fastify";
import type {
  ProviderObservedState,
  ProviderReadinessState,
  ProviderRouteStatus
} from "@companion/providers";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import {
  readMemoryIngestionDiagnostics,
  toMemoryIngestionHealthSnapshot
} from "../memory-ingestion-diagnostics.js";

const startedAt = Date.now();

export async function registerHealthRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
): Promise<void> {
  app.get("/health", async () => {
    const database = await context.memoryRepository.healthCheck();
    const providerStatus = context.providers.getStatus();
    const chat = providerStatus.providers.chat;
    const chatCapability = summarizeChatCapability(providerStatus.routes?.chat ?? []);

    // Health uses locally ready chat routes as the service-operability gate.
    // A ready route can keep the service operational while observed remains
    // unknown; that is not evidence of remote reachability. Provider status
    // inspection itself remains zero-provider-I/O.
    const ok =
      database.status === "healthy" &&
      chatCapability.readiness === "ready" &&
      chatCapability.operational;
    const memoryIngestion = toMemoryIngestionHealthSnapshot(
      await readMemoryIngestionDiagnostics(context.memoryIngestionCoordinator)
    );

    return {
      ok,
      conversationalReadiness:
        chatCapability.readiness !== "ready"
          ? "NOT_CONFIGURED"
          : chatCapability.operational
            ? "READY"
            : "UNAVAILABLE",
      service: "ai-companion-runtime",
      character: {
        instanceId: context.runtime.characterBinding.instanceId,
        definitionId: context.runtime.characterBinding.definition.id,
        definitionRevision: context.runtime.characterBinding.definition.revision,
        name: context.runtime.characterBinding.definition.name
      },
      runtimeMode: config.runtimeMode,
      uptime: {
        seconds: Math.floor((Date.now() - startedAt) / 1000),
        startedAt: new Date(startedAt).toISOString()
      },
      server: { status: "healthy" },
      database,
      memoryIngestion,
      providers: {
        chat,
        chatCapability,
        optional: {
          reasoning: providerStatus.providers.reasoning,
          tts: providerStatus.providers.tts,
          stt: providerStatus.providers.stt,
          vision: providerStatus.providers.vision,
          embedding: providerStatus.providers.embedding
        }
      }
    };
  });
}

type ChatCapabilityHealth = {
  readiness: ProviderReadinessState;
  observed: ProviderObservedState;
  operational: boolean;
  routeCount: number;
  readyRouteCount: number;
  readyProviders: Array<{
    provider: string;
    priority: number;
    observed: ProviderObservedState;
    status: ProviderRouteStatus["status"];
  }>;
};

function summarizeChatCapability(routes: ProviderRouteStatus[]): ChatCapabilityHealth {
  const readyRoutes = routes.filter((route) => route.readiness === "ready");
  // `operational` means that at least one locally constructible route is not
  // known unavailable. It deliberately does not turn readiness into a live
  // provider health check.
  const operational = readyRoutes.some((route) => route.observed !== "unavailable");

  let observed: ProviderObservedState = "unavailable";
  if (readyRoutes.some((route) => route.observed === "available")) {
    observed = "available";
  } else if (readyRoutes.some((route) => route.observed === "unknown")) {
    observed = "unknown";
  } else if (readyRoutes.some((route) => route.observed === "degraded")) {
    observed = "degraded";
  }

  return {
    readiness: readyRoutes.length > 0 ? "ready" : "not_ready",
    observed,
    operational,
    routeCount: routes.length,
    readyRouteCount: readyRoutes.length,
    readyProviders: readyRoutes.map((route) => ({
      provider: route.provider,
      priority: route.priority,
      observed: route.observed ?? "unknown",
      status: route.status
    }))
  };
}
