import { NativeMemoryPermission } from "./native-product-permissions.js";
import { ProductAuthorityMemory } from "./product-authority-memory.js";
import { useEffect, useState, useRef, type ReactNode } from "react";
import {
  nativeActivation,
  nativeIdentityChanged,
  type NativeActivationState
} from "./native-product-client.js";
import {
  productRequest,
  notifyProductHost,
  type ProductHostState
} from "./product-memory-client.js";

/** Native consent, selection and recovery; the page never handles a pairing code or credential. */
export function NativeActivation({ children }: { children: ReactNode }): JSX.Element {
  const refreshing = useRef(0);
  const [view, setView] = useState<NativeActivationState | null>(null);
  const [memoryAllowed, setMemoryAllowed] = useState(false);
  const [active, setActive] = useState(false);
  const [choose, setChoose] = useState(false);
  const [memory, setMemory] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const current = ++refreshing.current;
    const next = await nativeActivation();
    let enabled = false;
    let memoryEnabled = false;
    let identity: { personId: string; personaId: string } | null = null;
    if (next.person) {
      try {
        let host = await productRequest<ProductHostState>("/host/v1/product/status");
        if (host.status === "EXPIRED")
          host = await productRequest<ProductHostState>("/host/v1/product/renew", {});
        memoryEnabled = host.memoryEnabled;
        enabled = host.status === "ACTIVE" && host.personId === next.person.id;
        if (enabled) identity = { personId: host.personId, personaId: host.personaId };
      } catch {
        /* Unavailable identity stays closed; fence stale async results below. */
      }
    }
    if (current !== refreshing.current) return;
    notifyProductHost(identity?.personId ?? null, identity?.personaId);
    setMemoryAllowed(memoryEnabled);
    setView(next);
    setActive(enabled);
    setError(null);
  }
  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    const change = () => {
      nativeIdentityChanged();
      setActive(false);
      setView(null);
      notifyProductHost(null);
      void refresh().catch((e) => setError(String(e)));
    };
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const unlisten = await listen("native-product-changed", change);
        const unpermissions = await listen("native-product-permissions-changed", () => {
          void refresh().catch((e) => setError(String(e)));
        });
        if (disposed) {
          unlisten();
          unpermissions();
          return;
        }
        stop = () => {
          unlisten();
          unpermissions();
        };
        await refresh();
      })
      .catch((e) => setError(String(e)));
    const timer = setInterval(() => {
      void refresh().catch((e) => {
        if (!disposed) {
          setActive(false);
          setError(String(e));
        }
      });
    }, 4000);
    return () => {
      disposed = true;
      refreshing.current++;
      clearInterval(timer);
      stop?.();
    };
  }, []);
  async function act(action: string, args: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      await nativeActivation(action, args);
      await refresh();
      if (action === "select") setChoose(false);
      setName("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (active && !choose && view?.person)
    return (
      <div className="native-product" key={view.person.id}>
        <div className="native-identity-bar">
          <span>当前身份：{view.person.displayName}</span>{" "}
          <button onClick={() => setMemory(false)}>聊天</button>{" "}
          <button onClick={() => setMemory(true)}>记忆</button>{" "}
          <button onClick={() => setChoose(true)}>切换身份</button>{" "}
          <button disabled={busy} onClick={() => void act("logout")}>
            退出身份
          </button>
        </div>
        <NativeMemoryPermission.Provider value={memoryAllowed}>
          {memory ? (
            <div className="yuvi-webui">
              <ProductAuthorityMemory />
            </div>
          ) : (
            children
          )}
        </NativeMemoryPermission.Provider>
      </div>
    );
  return (
    <main className="yuvi-card native-activation" aria-label="本机身份">
      <h1>欢迎使用 YUVI</h1>
      <p>确认本机所有权，然后创建或选择你的身份。身份确认将在原生系统对话框中完成。</p>
      {error && <p role="alert">{error}</p>}
      {!view ? (
        <button disabled={busy} onClick={() => void refresh().catch((e) => setError(String(e)))}>
          重新连接
        </button>
      ) : !view.owned ? (
        <button disabled={busy} onClick={() => void act("own")}>
          确认本机所有权
        </button>
      ) : (
        <>
          {view.serviceUnavailable && (
            <p role="status">本机身份服务尚未就绪。请稍候或重新连接；不会连接其他实例。</p>
          )}
          {view.people.map((person) => (
            <p key={person.id}>
              <button
                disabled={busy || view.pending || view.revocationPending}
                onClick={() => void act("select", { personId: person.id })}
              >
                以 {person.displayName} 进入
              </button>
            </p>
          ))}
          {view.revocationPending ? (
            <>
              <p role="alert">已停止此桌面的私人访问；服务端撤销尚未确认。请继续完成退出。</p>
              <button disabled={busy} onClick={() => void act("logout")}>
                继续完成退出
              </button>
            </>
          ) : view.pending ? (
            <>
              <p>上次创建尚未确认。继续核对同一次创建，避免重复。</p>
              <button disabled={busy} onClick={() => void act("resume")}>
                恢复上次创建
              </button>
            </>
          ) : (
            <>
              <label>
                你的名字{" "}
                <input
                  aria-label="你的名字"
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>{" "}
              <button
                disabled={busy || !name.trim() || view.serviceUnavailable}
                onClick={() => void act("create", { name })}
              >
                创建我的身份
              </button>
            </>
          )}
          {active && <button onClick={() => setChoose(false)}>返回</button>}
        </>
      )}
    </main>
  );
}
