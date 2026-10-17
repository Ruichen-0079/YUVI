import { appendFile, readFile } from "node:fs/promises";
import { createPostgresPool } from "@companion/database";
import { EffectDispatcher, PostgresEffectDispatchStore } from "@companion/effects";
import { actualReadEvidence, reportProjection } from "./observation-atomic.js";
const [id, path, stage] = process.argv.slice(2) as [string, string, string];
const db = createPostgresPool(process.env["YUVI_ATOMIC_CHILD_DATABASE_URL"]!);
const checkpoint = async () => {
  process.send?.({ checkpoint: stage });
  await new Promise<void>(() => {});
};
const store = new PostgresEffectDispatchStore(db);
if (stage === "before-start") {
  const original = store.start.bind(store);
  store.start = async (...args) => {
    await checkpoint();
    return original(...args);
  };
}
const dispatcher = new EffectDispatcher(
  store,
  [
    {
      contractRef: "yuvi.read-text.v1",
      adapter: "yuvi.local-read-text.v1",
      isCurrent: () => true,
      async invoke(intent, attempt) {
        const text = await readFile(path, "utf8");
        await appendFile(path + ".calls", "read\n");
        if (stage === "after-adapter") await checkpoint();
        return {
          evidence: actualReadEvidence,
          transientResult: text,
          projection: reportProjection(
            attempt.attemptId,
            intent.request.causalRefs[0],
            text,
            stage === "in-projection" ? checkpoint : undefined
          )
        };
      }
    }
  ],
  30000
);
await dispatcher.run(id);
await checkpoint();
