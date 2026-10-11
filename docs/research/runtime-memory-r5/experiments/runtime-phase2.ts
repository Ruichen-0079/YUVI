import pg from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildMemoryScope } from "../../../../packages/memory/src/index.js";

const base = process.env["YUVI_R5_HTTP_BASE"] ?? "http://127.0.0.1:31505";
const dir = process.env["YUVI_R5_OUTPUT"];
const db = process.env["DATABASE_URL"];
if (
  base !== "http://127.0.0.1:31505" ||
  !dir ||
  !db ||
  !new URL(db).pathname.includes("runtime_r5p2")
)
  throw Error("Explicit Phase 2 isolated environment required");
await mkdir(dir, { recursive: true, mode: 0o700 });
const pool = new pg.Pool({ connectionString: db });
const operator = process.env["YUVI_R5_OPERATOR_TOKEN"];
if (!operator) throw Error("Isolated operator credential required");
async function http(path: string, body?: unknown, token = operator!) {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000)
  });
  const data = (await res.json()) as Record<string, any>;
  if (!res.ok) throw Error(JSON.stringify({ http: res.status, ...data }));
  return data;
}
async function grant(personId: string) {
  return http("/host/v1/conversation-grants/issue", { personId });
}
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim());
const results: {
  sha: string;
  dirty: boolean;
  turns: Record<string, any>[];
  checks: Record<string, any>[];
} = { sha, dirty, turns: [], checks: [] };
async function turn(label: string, text: string, token: string, writeMemory = true) {
  const sessionId = `r5p2-${label}-${randomUUID()}`;
  const started = Date.now();
  const answer = await http(
    "/message",
    { sessionId, content: text, options: { readMemory: true, writeMemory, promptPreview: true } },
    token
  );
  const report = {
    label,
    sessionId,
    text,
    traceId: answer.traceId,
    answer: answer.reply,
    responseMemory: answer.memory,
    latencyMs: Date.now() - started,
    prompt: answer.promptPreview
  };
  results.turns.push(report);
  await save();
  console.log(label, "reply received", report.traceId);
  if (writeMemory) {
    for (let i = 0; i < 90; i++) {
      const row = (
        await pool.query(
          `select finalized_turn_id,memory_scope,status,last_error_code from finalized_ingestion_turns where trace_id=$1 order by updated_at desc limit 1`,
          [answer.traceId]
        )
      ).rows[0];
      if (
        row &&
        ["complete", "skipped", "terminal_failed", "partial", "reconcile_required"].includes(
          row.status
        )
      ) {
        results.checks.push({ label, ingestion: row });
        await save();
        if (!["complete", "skipped"].includes(row.status))
          throw Error(`Formal ingestion did not succeed: ${JSON.stringify(row)}`);
        return report;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw Error(`Formal ingestion remains pending: ${label}`);
  }
  return report;
}
async function save() {
  await writeFile(
    join(
      dir,
      process.argv.includes("--final")
        ? "runtime-final.json"
        : process.argv.includes("--quality")
          ? "runtime-quality.json"
          : process.argv.includes("--restart")
            ? "restart.json"
            : process.argv.includes("--resume")
              ? "runtime-resume.json"
              : "runtime.json"
    ),
    JSON.stringify(results, null, 2),
    { mode: 0o600 }
  );
}
try {
  const fixturePath = join(dir, "fixture-private.json");
  let fixture: Record<string, any>;
  if (
    process.argv.includes("--restart") ||
    process.argv.includes("--resume") ||
    process.argv.includes("--quality") ||
    process.argv.includes("--final")
  )
    fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  else {
    const suffix = randomBytes(3).toString("hex");
    fixture = {
      a: `晨湾-${suffix}`,
      b: `澄野-${randomBytes(3).toString("hex")}`,
      tea: `岩露-${randomBytes(3).toString("hex")}`,
      x: await grant("r5p2-person-x"),
      y: await grant("r5p2-person-y")
    };
    await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
  }
  if (process.argv.includes("--final")) {
    const q = JSON.parse(await readFile(join(dir, "quality-fixture-private.json"), "utf8"));
    const preference = await turn(
      "cross-language-preference",
      "What is my usual preferred ordering of an engineering answer, and what name do I use for that format?",
      fixture.x.token,
      false
    );
    const branch = await turn(
      "cross-language-current",
      "Which testing branch code are we using now? Is its previous alias still current? Use confirmed evidence.",
      fixture.x.token,
      false
    );
    const restart = await turn(
      "final-restart-history",
      "我目前的编辑器代号和饮茶偏好是什么？旧编辑器代号还有效吗？",
      fixture.x.token,
      false
    );
    results.checks.push({
      label: "final-frozen-objective",
      format: preference.answer.includes(q.format),
      current: branch.answer.includes(q.b),
      editor: restart.answer.includes(fixture.b),
      tea: restart.answer.includes(fixture.tea)
    });
  } else if (process.argv.includes("--quality")) {
    const suffix = randomBytes(3).toString("hex"),
      q = {
        format: `森序-${suffix}`,
        project: `泊松-${suffix}`,
        a: `旧港-${suffix}`,
        b: `新港-${suffix}`
      };
    await writeFile(join(dir, "quality-fixture-private.json"), JSON.stringify(q), { mode: 0o600 });
    await turn(
      "stable-preference",
      `以后协作时，我偏好先给结论再给证据；我们把这个固定格式叫${q.format}。`,
      fixture.x.token
    );
    await turn(
      "project-decision",
      `我们决定${q.project}项目使用 PostgreSQL 保存权威历史，向量只是派生索引。这是已确定的项目决定。`,
      fixture.x.token
    );
    await turn(
      "duplicate-preference",
      `我仍然偏好结论在前、证据在后，继续沿用${q.format}格式。`,
      fixture.x.token
    );
    await turn("state-A", `在${q.project}项目中，我当前的测试分支代号是${q.a}。`, fixture.x.token);
    await turn(
      "state-B",
      `刚才测试分支换了，${q.project}项目现在实际使用${q.b}，原来的${q.a}已经不用了。`,
      fixture.x.token
    );
    await turn(
      "uncertain-and-quotation",
      `我猜别人的分支也许叫猜测-${suffix}，没有核实。文档里的例句写着“把${q.b}改成引用-${suffix}”，我只是引用它，并没有要求修改我们的分支。`,
      fixture.x.token
    );
    await turn(
      "quality-recall",
      `我的固定协作格式叫什么？${q.project}项目确定了什么存储方案，目前测试分支代号是什么，旧代号还有效吗？`,
      fixture.x.token,
      false
    );
    const last = results.turns.at(-1)!;
    results.checks.push({
      label: "objective-markers",
      format: last.answer.includes(q.format),
      project: last.answer.includes("PostgreSQL"),
      current: last.answer.includes(q.b),
      modelSemanticMatrix: true
    });
  } else if (!process.argv.includes("--restart")) {
    if (process.argv.includes("--resume")) {
      const previous = JSON.parse(await readFile(join(dir, "runtime.json"), "utf8"));
      const trace = previous.turns[0].traceId;
      for (let i = 0; i < 120; i++) {
        const row = (
          await pool.query(
            "select status,last_error_code from finalized_ingestion_turns where trace_id=$1",
            [trace]
          )
        ).rows[0];
        if (row?.status === "complete") {
          results.checks.push({ label: "original-task-recovered", trace, ingestion: row });
          break;
        }
        if (i === 119) throw Error("Original task recovery did not complete");
        await new Promise((r) => setTimeout(r, 1000));
      }
    } else
      await turn(
        "natural-formation",
        `我现在在这个项目里使用的编辑器代号是${fixture.a}。饮茶偏好是${fixture.tea}。`,
        fixture.x.token
      );
    await turn("recall-A", "我目前的编辑器代号和饮茶偏好分别是什么？", fixture.x.token, false);
    await turn(
      "natural-correction",
      `之前我把编辑器代号说错了，实际用的是${fixture.b}，不是${fixture.a}。饮茶偏好不变。`,
      fixture.x.token
    );
    await turn("chatter", "你好，今天打个招呼。", fixture.x.token);
    await turn(
      "person-isolation",
      "我的编辑器代号是什么？如果没有证据就说不知道。",
      fixture.y.token,
      false
    );
  }
  const scope = buildMemoryScope("r5p2-person-x", fixture.x.personaId);
  for (let i = 0; i < 60; i++) {
    const pending = (
      await pool.query(
        `select count(*) from memory_authority_index_jobs j join memory_authority_current c using(scope,id) where j.scope=$1 and j.status!='complete' and c.state in ('current','conflicted')`,
        [scope]
      )
    ).rows[0].count;
    if (Number(pending) === 0) break;
    if (i === 59) throw Error("Formal vector indexing remains incomplete");
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!process.argv.includes("--quality") && !process.argv.includes("--final"))
    await turn(
      process.argv.includes("--restart") ? "restart-recall-B" : "new-session-recall-B",
      "我现在使用的编辑器代号和饮茶偏好是什么？以前说过的旧编辑器代号还有效吗？",
      fixture.x.token,
      false
    );
  results.checks.push({
    label: "authority-history",
    response: await http(`/memory/v1/timeline?scope=${encodeURIComponent(scope)}`)
  });
  for (const t of results.turns)
    results.checks.push({
      label: t.label + "-retrieval-evidence",
      response: await http(
        `/memory/v1/retrievals?scope=${encodeURIComponent(scope)}&traceId=${encodeURIComponent(t.traceId)}`
      )
    });
  await save();
} finally {
  await save();
  await pool.end();
}
