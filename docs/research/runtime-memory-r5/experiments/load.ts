/** Synthetic index load, NOT LLM grounding or provider-write throughput.
 * Guarded isolated DB only. Uses production PostgreSQL schema/projection/reader.
 */
import pg from "pg";
import { performance } from "node:perf_hooks";
import { writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  MemoryKnowledgeReader,
  PostgresMemoryAuthority,
  PostgresMemoryProvider,
  verifyMemoryProjection,
  rebuildMemoryProjection
} from "../../../../packages/memory/src/index.js";
const url = process.env["DATABASE_URL"];
if (!url || !new URL(url).pathname.includes("runtime_r5_"))
  throw new Error("Isolated R5 database required");
const pool = new pg.Pool({ connectionString: url, max: 4, application_name: "r5-load-experiment" });
const reader = new MemoryKnowledgeReader(pool);
const scope = "yuvi:v1:user:r5-load:character:r5-load";
const sourceSHA = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const report: { scale: number; [key: string]: unknown }[] = [];
const target = Number(process.argv[2] ?? "1000000");
const destination = process.argv[3] ?? "/tmp/r5-load.json";
try {
  await pool.query("insert into memory_authority_scopes(scope) values($1) on conflict do nothing", [
    scope
  ]);
  let size = Number((await reader.overview(scope)).records);
  for (const scale of process.argv.includes("--read-existing")
    ? [size]
    : [1000, 10000, 100000, 1000000].filter((n) => n <= target)) {
    const started = performance.now();
    for (let from = size + 1; from <= scale; from += 10000) {
      const end = Math.min(scale, from + 9999);
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query(
          `insert into memory_authority_records(scope,id,logical_key,digest,version,source_at,classification,event,search_terms)
          select $1,'load_'||g,'load_'||g,repeat('0',64),g,'2026-10-01','GROUNDED',
            jsonb_build_object('id','load_'||g,'kind','fact','content','synthetic token_'||g||' topic_'||(g%1000),'source','postgres','sourceRecordId','load_'||g,'scope',$1::text,'metadata',jsonb_build_object('syntheticIndexLoad',true),
              'lineage',jsonb_build_object('authority',jsonb_build_object('principal',jsonb_build_object('state','RESOLVED'),'binding',jsonb_build_object('state','RESOLVED'),'audience',jsonb_build_object('kind','PRIVATE')))),
            'synthetic token_'||g||' topic_'||(g%1000) from generate_series($2::bigint,$3::bigint) g`,
          [scope, from, end]
        );
        await c.query(
          `insert into memory_authority_current(scope,id,version,state,search)
          select scope,id,version,'current',to_tsvector('simple',search_terms) from memory_authority_records where scope=$1 and version between $2 and $3`,
          [scope, from, end]
        );
        await c.query(
          "update memory_authority_scopes set version=$2,projection_version=$2,record_count=$2,current_count=$2 where scope=$1",
          [scope, end]
        );
        await c.query("commit");
      } catch (error) {
        await c.query("rollback");
        throw error;
      } finally {
        c.release();
      }
    }
    size = scale;
    await pool.query("analyze memory_authority_current");
    await pool.query("analyze memory_authority_records");
    const loadMs = performance.now() - started;
    const queries = {
      page: () => reader.page({ scope, limit: 20 }),
      detail: () => reader.detail(scope, `load_${Math.ceil(scale * 0.53)}`),
      text: () => reader.search(scope, `token_${Math.ceil(scale * 0.53)}`, 8),
      broadText: () => reader.search(scope, "synthetic", 8)
    };
    const latencies: Record<string, unknown> = {};
    for (const [name, run] of Object.entries(queries)) {
      const values: number[] = [];
      for (let i = 0; i < 110; i++) {
        const t = performance.now();
        await run();
        if (i >= 10) values.push(performance.now() - t);
      }
      values.sort((a, b) => a - b);
      latencies[name] = {
        samples: values.length,
        p50: values[49],
        p95: values[94],
        p99: values[98]
      };
    }
    const startConcurrent = performance.now();
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let i = 0; i < 100; i++) await reader.page({ scope, limit: 20 });
      })
    );
    const concurrentMs = performance.now() - startConcurrent;
    const storage = (
      await pool.query(
        `select relname,pg_total_relation_size(oid)::text as total_bytes,pg_indexes_size(oid)::text as index_bytes from pg_class where relname in ('memory_authority_records','memory_authority_current')`
      )
    ).rows;
    const io = (
      await pool.query(
        "select blks_read,blks_hit,tup_returned,tup_fetched,temp_bytes from pg_stat_database where datname=current_database()"
      )
    ).rows[0];
    const verification = await verifyMemoryProjection(
      pool,
      scope,
      String(Math.max(0, scale - 1000)),
      1000
    );
    const row = {
      sourceSHA,
      scale,
      loadMs,
      latencies,
      concurrency: 4,
      pageRequests: 400,
      pageThroughputPerSecond: 400 / (concurrentMs / 1000),
      storage,
      io,
      verification
    };
    if (process.argv.includes("--resource")) {
      const plans = {} as Record<string, unknown>;
      for (const [name, sql, params] of [
        [
          "page",
          "select r.*,c.state from memory_authority_current c join memory_authority_records r using(scope,id) where c.scope=$1 and c.state in ('current','conflicted') order by c.version desc limit 20",
          [scope]
        ],
        [
          "text",
          "with candidates as materialized(select scope,id,state,version,search from memory_authority_current where scope=$1 and state in ('current','conflicted') and search @@ to_tsquery('simple',$2) limit 513) select r.*,c.state from candidates c join memory_authority_records r using(scope,id) order by ts_rank(c.search,to_tsquery('simple',$2)) desc,c.version desc limit 8",
          [scope, "token_530000"]
        ]
      ] as const)
        plans[name] = (
          await pool.query("explain (analyze,buffers,format json) " + sql, [...params])
        ).rows;
      const processes = new Map<
        number,
        { initialTicks: number; finalTicks: number; peakRssBytes: number }
      >();
      let running = true;
      const sample = async () => {
        const pids = (
          await pool.query(
            "select pid from pg_stat_activity where application_name='r5-load-experiment' and datname=current_database()"
          )
        ).rows;
        for (const { pid } of pids) {
          try {
            const raw = await readFile(`/proc/${pid}/stat`, "utf8");
            const fields = raw
              .slice(raw.lastIndexOf(")") + 2)
              .trim()
              .split(/\s+/u);
            const ticks = Number(fields[11]) + Number(fields[12]);
            const rss = Number(fields[21]) * 4096;
            const old = processes.get(pid) ?? {
              initialTicks: ticks,
              finalTicks: ticks,
              peakRssBytes: rss
            };
            old.finalTicks = ticks;
            old.peakRssBytes = Math.max(old.peakRssBytes, rss);
            processes.set(pid, old);
          } catch {
            /* PID may have closed between discovery and sampling. */
          }
        }
      };
      await sample();
      const sampling = (async () => {
        while (running) {
          await new Promise((r) => setTimeout(r, 50));
          await sample();
        }
      })();
      const started = performance.now();
      const until = started + 5000;
      let requests = 0;
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          while (performance.now() < until) {
            await reader.page({ scope, limit: 20 });
            requests++;
          }
        })
      );
      running = false;
      await sampling;
      const resource = {
        workload:
          "5s indexed current page, 3 concurrent readers; fourth connection samples own experiment backends",
        elapsedMs: performance.now() - started,
        requests,
        sampleIntervalMs: 50,
        ticksPerSecond: Number(
          spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim()
        ),
        processes: [...processes].map(([pid, metrics]) => ({ pid, ...metrics }))
      };
      Object.assign(row, { plans, resource });
    }
    report.push(row);
    await writeFile(destination, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({ scale, loadMs, latencies, throughput: row.pageThroughputPerSecond })
    );
  }
  if (target >= 1000000 && !process.argv.includes("--read-existing")) {
    const start = performance.now();
    await rebuildMemoryProjection(new PostgresMemoryAuthority(pool), scope);
    report.at(-1)!["rebuildMs"] = performance.now() - start;
    report.at(-1)!["afterRebuildVerification"] = await verifyMemoryProjection(
      pool,
      scope,
      "999000",
      1000
    );
    await writeFile(destination, JSON.stringify(report, null, 2));
    console.log("Million-record atomic rebuild completed");
  }
} finally {
  await pool.end();
}
