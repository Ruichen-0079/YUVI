/** Bounded owner-to-acceptance source inventory, archived with each conformance run. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const groups = [
  [
    "Character composition / independent perspective",
    [
      "packages/core/src/character-identity.ts",
      "packages/memory/src/character-scope.ts",
      "packages/memory/src/character-provider.ts",
      "apps/server/src/character-composition.ts",
      "apps/server/src/character-storage.ts"
    ],
    [
      "packages/core/src/multi-character.test.ts",
      "packages/memory/src/character-scope.test.ts",
      "packages/providers/src/multi-character.test.ts",
      "apps/server/src/character-composition.test.ts",
      "apps/server/src/multi-character.integration.test.ts"
    ]
  ],
  [
    "Journal/ingress",
    ["packages/journal/src/index.ts", "apps/server/src/conversational-receipt-admission.ts"],
    [
      "packages/journal/test/postgres-store.integration.test.ts",
      "apps/server/src/release-conformance.postgres.integration.test.ts"
    ]
  ],
  [
    "A4/Runtime/context",
    [
      "packages/core/src/runtime-orchestrator.ts",
      "apps/server/src/context-use.ts",
      "packages/memory/src/context-use-repository.ts"
    ],
    [
      "apps/server/src/outward-transport.postgres.integration.test.ts",
      "packages/memory/src/context-use-repository.postgres.integration.test.ts"
    ]
  ],
  [
    "canonical A9",
    [
      "packages/effects/src/admission.ts",
      "packages/effects/src/store.ts",
      "packages/effects/src/dispatch-store.ts",
      "packages/effects/src/dispatcher.ts"
    ],
    [
      "packages/effects/test/dispatch.postgres.integration.test.ts",
      "packages/effects/test/postgres.integration.test.ts"
    ]
  ],
  [
    "provider/publication",
    [
      "packages/providers/src/registry.ts",
      "apps/server/src/outward-effects.ts",
      "packages/memory/src/conversation-repository.ts"
    ],
    [
      "apps/server/src/outward-effects.integration.test.ts",
      "apps/server/src/release-conformance.postgres.integration.test.ts"
    ]
  ],
  [
    "HTTP/SSE/WS/proactive surfaces",
    [
      "apps/server/src/routes/message.ts",
      "apps/server/src/routes/message-stream.ts",
      "apps/server/src/routes/websocket.ts",
      "apps/server/src/routes/proactive-turn-stream.ts"
    ],
    ["apps/server/src/outward-transport.postgres.integration.test.ts"]
  ],
  [
    "media/presentation",
    [
      "apps/server/src/media-effects.ts",
      "apps/server/src/presentation-effects.ts",
      "apps/web/src/speech-segmenter.ts"
    ],
    [
      "apps/server/src/outward-effects.integration.test.ts",
      "apps/web/src/speech-conservation.test.ts",
      "apps/web/src/embodied-presentation-executor.test.ts"
    ]
  ],
  [
    "native owners",
    [
      "apps/server/src/product-person-command-effects.ts",
      "apps/server/src/context.ts",
      "packages/memory/src/providers/local-controller-evidence.ts"
    ],
    [
      "apps/server/src/product-control-journal-ingress.integration.test.ts",
      "apps/server/src/voice-control-journal-ingress.integration.test.ts",
      "apps/server/src/runtime-control-journal-ingress.integration.test.ts"
    ]
  ],
  [
    "Finalized/Dream exclusive owners",
    [
      "packages/memory/src/finalized-ingestion-executor.ts",
      "packages/memory/src/memory-ingestion-coordinator.ts",
      "packages/memory/src/dream-consolidation.ts"
    ],
    [
      "packages/memory/src/memory-ingestion-coordinator.test.ts",
      "packages/memory/src/grounded-dream.integration.test.ts",
      "apps/server/src/grounded-finalized-mem0.integration.test.ts",
      "apps/server/src/canonical-evidence-admission.integration.test.ts"
    ]
  ],
  [
    "shutdown/packaged lifecycle",
    [
      "apps/server/src/server.ts",
      "packages/desktop-supervisor/src/supervisor.ts",
      "scripts/yuvi-runtime-server.packaged.mts"
    ],
    [
      "packages/desktop-supervisor/src/postgres-lifecycle.pg.test.ts",
      "scripts/conformance/packaged-linux.mjs"
    ]
  ]
];
const entry = (file) => ({
  file,
  digest: createHash("sha256").update(fs.readFileSync(file)).digest("hex")
});
const inventory = {
  version: "a11-owner-audit.v1",
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  groups: groups.map(([owner, production, evidence]) => ({
    owner,
    production: production.map(entry),
    evidence: evidence.map(entry)
  }))
};
const destination = path.join(
  process.env.YUVI_CONFORMANCE_ARCHIVE_ROOT ?? "build/conformance",
  "owner-audit.json"
);
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(inventory, null, 2));
console.log(`Bounded production owner inventory: ${destination}`);
