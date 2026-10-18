import { useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "./tauri-window.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import {
  knowledgeClient,
  productMemoryScope,
  productRequest,
  notifyProductHost,
  ProductMemoryError,
  type ProductHostState
} from "./product-memory-client.js";
type KnowledgePage = Awaited<ReturnType<typeof knowledgeClient.current>>;
type Detail = Awaited<ReturnType<typeof knowledgeClient.detail>>;
type Relations = Awaited<ReturnType<typeof knowledgeClient.relations>>;
type Retrieval = Awaited<ReturnType<typeof knowledgeClient.retrieval>>;

export function ProductAuthorityMemory(): JSX.Element {
  const generation = useRef(0);
  const [host, setHost] = useState<ProductHostState | null>(null);
  const [code, setCode] = useState("");
  const [personId, setPersonId] = useState("");
  const browserOrigin = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u.test(
    window.location.origin
  );
  const [origin, setOrigin] = useState(() => (browserOrigin ? window.location.origin : ""));
  const [generatedCode, setGeneratedCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historical, setHistorical] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [relations, setRelations] = useState<Relations | null>(null);
  const [retrieval, setRetrieval] = useState<Retrieval | null>(null);
  const scope = host ? productMemoryScope(host) : null;
  const allowed = host?.status === "ACTIVE" && host.memoryEnabled;
  const records = useAsyncData(
    async () =>
      allowed && scope
        ? historical
          ? {
              scope,
              page: await knowledgeClient.timeline({
                scope,
                limit: 20,
                ...(cursor ? { cursor } : {})
              })
            }
          : {
              scope,
              page: await knowledgeClient.current({
                scope,
                limit: 20,
                ...(cursor ? { cursor } : {})
              })
            }
        : null,
    [allowed, scope, historical, cursor],
    { preserveDataOnRefresh: false }
  );
  const runs = useAsyncData(
    async () =>
      allowed && scope
        ? { scope, page: await knowledgeClient.retrievals({ scope, limit: 10 }) }
        : null,
    [allowed, scope],
    { preserveDataOnRefresh: false }
  );
  const visibleRecords = records.data?.scope === scope ? records.data.page : null;
  const visibleRuns = runs.data?.scope === scope ? runs.data.page : null;
  async function status() {
    const current = ++generation.current;
    setHost(null);
    setDetail(null);
    setRelations(null);
    setRetrieval(null);
    try {
      const next = await productRequest<ProductHostState>("/host/v1/product/status");
      if (current !== generation.current) return;
      notifyProductHost(next.personId, next.personaId);
      setHost(next);
      setError(null);
    } catch (e) {
      if (current !== generation.current) return;
      if (e instanceof ProductMemoryError && e.status === 401) notifyProductHost(null);
      setHost(null);
      setError(
        e instanceof ProductMemoryError && e.status === 401
          ? "尚未授权或授权已撤销，请使用本机配对码绑定。"
          : "身份服务不可用，请重试；这不表示没有记忆。"
      );
    }
  }
  useEffect(() => {
    void status();
    window.addEventListener("focus", status);
    const onStorage = (event: StorageEvent) => {
      if (event.key === "yuvi.product-host-person") void status();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      generation.current++;
      window.removeEventListener("focus", status);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  useEffect(() => {
    setCursor(undefined);
    setDetail(null);
    setRelations(null);
    setRetrieval(null);
  }, [scope, allowed]);
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作状态未知，请检查后重试。");
    } finally {
      setBusy(false);
    }
  }
  async function bind() {
    await productRequest("/host/v1/product/pair", { code: code.trim() });
    setCode("");
    await status();
    const next = await productRequest<ProductHostState>("/host/v1/product/status");
    notifyProductHost(next.personId, next.personaId);
  }
  async function select(id: string) {
    if (!scope) return;
    setDetail(null);
    setRelations(null);
    const current = generation.current;
    const [d, r] = await Promise.all([
      knowledgeClient.detail(scope, id),
      knowledgeClient.relations(scope, id)
    ]);
    if (current !== generation.current) return;
    setDetail(d);
    setRelations(r);
  }
  return (
    <section className="yuvi-card yuvi-authority-memory" aria-label="Authority Memory">
      <h2>长期记忆与身份</h2>
      <p>
        当前认识来自 R5
        Authority。修改认识请在正常聊天中说明纠正；此页面只读，不直接改写或删除历史。
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="yuvi-product-actions">
        <label>
          一次性配对码{" "}
          <input
            aria-label="一次性配对码"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            type="password"
          />
        </label>
        <button disabled={busy || !code.trim() || !browserOrigin} onClick={() => void act(bind)}>
          绑定身份
        </button>
        <button disabled={busy} onClick={() => void act(status)}>
          刷新身份
        </button>
      </div>
      <p>
        配对码由本机 Desktop Supervisor
        生成，五分钟内有效且只能使用一次。普通网页无法签发；当前仅支持本机浏览器 WebUI。
      </p>
      {!browserOrigin && (
        <p role="status">
          此打包 WebView 的 Origin 尚不支持浏览器 Cookie 配对。请为明确的本机 HTTP WebUI
          生成配对码，在该浏览器窗口绑定和聊天；此窗口不会伪装已授权。
        </p>
      )}
      {isTauriRuntime() && (
        <div className="yuvi-product-actions">
          <label>
            Person ID <input value={personId} onChange={(e) => setPersonId(e.target.value)} />
          </label>
          <label>
            浏览器 WebUI 地址 <input value={origin} onChange={(e) => setOrigin(e.target.value)} />
          </label>
          <button
            disabled={busy || !personId || !origin}
            onClick={() =>
              void act(async () => {
                const { invoke } = await import("@tauri-apps/api/core");
                const pairing = await invoke<{ code: string }>("create_product_host_pairing", {
                  personId,
                  origin
                });
                setGeneratedCode(pairing.code);
                if (origin === window.location.origin) setCode(pairing.code);
              })
            }
          >
            为本机 WebUI 生成配对码
          </button>
        </div>
      )}
      {generatedCode && (
        <p>
          一次性配对码（五分钟）：<code>{generatedCode}</code>。仅在指定 WebUI 地址手动使用。
        </p>
      )}
      {host && (
        <>
          <p role="status">
            身份：{host.personId} · Persona：{host.personaId} · {host.status} · 到期：
            {host.expiresAt}
          </p>
          <div className="yuvi-product-actions">
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setHost(await productRequest<ProductHostState>("/host/v1/product/renew", {}));
                })
              }
            >
              续期授权
            </button>
            <button
              disabled={busy || host.status !== "ACTIVE"}
              onClick={() =>
                void act(async () => {
                  generation.current++;
                  setDetail(null);
                  setRelations(null);
                  setRetrieval(null);
                  setHost(
                    await productRequest<ProductHostState>("/host/v1/product/memory", {
                      enabled: !host.memoryEnabled
                    })
                  );
                })
              }
            >
              {host.memoryEnabled ? "关闭长期记忆权限" : "开启长期记忆权限"}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await productRequest("/host/v1/product/revoke", {});
                  generation.current++;
                  setHost(null);
                  setDetail(null);
                  setRelations(null);
                  setRetrieval(null);
                  notifyProductHost(null);
                  setError("授权已撤销，记忆读取与写入已阻止。");
                })
              }
            >
              撤销此客户端授权
            </button>
            <a href="/#/main" target="yuvi-main">
              打开正常聊天
            </a>
          </div>
          {!host.memoryEnabled && <p role="status">长期记忆权限已关闭；聊天不因此变成持久学习。</p>}
        </>
      )}
      {allowed && scope && (
        <>
          <div className="yuvi-product-actions">
            <button
              onClick={() => {
                setHistorical(false);
                setCursor(undefined);
              }}
            >
              当前认识
            </button>
            <button
              onClick={() => {
                setHistorical(true);
                setCursor(undefined);
              }}
            >
              历史与纠正
            </button>
            <button
              onClick={() => {
                void records.refresh();
                void runs.refresh();
              }}
            >
              刷新记忆
            </button>
          </div>
          <h3>{historical ? "历史与纠正" : "当前认识"}</h3>
          {records.loading && <p role="status">正在读取…</p>}
          {records.error && <p role="alert">读取不可用：{records.error}。没有降级到旧 Memory。</p>}
          {visibleRecords?.records.length === 0 && <p>在此授权范围内没有可显示的认识。</p>}
          <ul>
            {visibleRecords?.records.map((r) => (
              <li key={r.id}>
                <button onClick={() => void act(() => select(r.id))}>{r.event.content}</button>{" "}
                <span>
                  {r.state} · {r.sourceAt} · {r.evidence.sourceOrigin}
                </span>
              </li>
            ))}
          </ul>
          {visibleRecords?.nextCursor && (
            <button onClick={() => setCursor(visibleRecords!.nextCursor!)}>下一页</button>
          )}
          {detail && (
            <article>
              <h3>记忆来源</h3>
              <p>
                {detail.event.content} · {detail.state}
              </p>
              <p>用户自述不等于外部证实：{detail.event.assertion?.verification ?? "unknown"}</p>
              <details>
                <summary>来源引用与纠正关系</summary>
                <pre>
                  {JSON.stringify(
                    {
                      id: detail.id,
                      evidence: detail.evidence,
                      source: detail.event.lineage,
                      relations: relations?.relations
                    },
                    null,
                    2
                  )}
                </pre>
              </details>
            </article>
          )}
          <h3>实际检索记录</h3>
          {runs.error && <p role="alert">检索审计不可用：{runs.error}</p>}
          <ul>
            {visibleRuns?.items.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() =>
                    void act(async () => {
                      const current = generation.current;
                      const result = await knowledgeClient.retrieval(scope, r.id);
                      if (current === generation.current) setRetrieval(result);
                    })
                  }
                >
                  {r.at} · {r.status}
                </button>
              </li>
            ))}
          </ul>
          {retrieval && (
            <article>
              <h4>{retrieval.query}</h4>
              <p>
                {retrieval.status} · 快照 {retrieval.watermark}
              </p>
              <ul>
                {retrieval.candidates.map((c) => (
                  <li key={c.id}>
                    {c.content} · {c.selected ? "已选入" : c.reason}
                  </li>
                ))}
              </ul>
              <p>Context 记录：{retrieval.contexts.length}；PREPARED 不代表模型一定正确使用。</p>
            </article>
          )}
        </>
      )}
    </section>
  );
}
