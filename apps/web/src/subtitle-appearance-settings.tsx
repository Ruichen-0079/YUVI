import { useEffect, useState } from "react";
import { t } from "./locale.js";
import {
  controlSubtitleWindow,
  getSubtitlePresentationState,
  isTauriRuntime,
  subscribeSurfaceChanged,
  setSubtitleLocked,
  type SubtitlePresentationState
} from "./tauri-window.js";

export function SubtitleAppearanceSettings(): JSX.Element | null {
  const tauri = isTauriRuntime();
  const [state, setState] = useState<SubtitlePresentationState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!tauri) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const next = await getSubtitlePresentationState();
        if (!cancelled) setState(next);
      } catch (error) {
        if (!cancelled) {
          setState(null);
          setNotice(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void refresh();
    const stopSurface = subscribeSurfaceChanged(
      () => void refresh(),
      (error) => {
        if (!cancelled) {
          setState(null);
          setNotice(String(error));
        }
      }
    );
    return () => {
      cancelled = true;
      stopSurface();
    };
  }, [tauri]);

  if (!tauri) return null;

  const refresh = async (): Promise<void> => {
    try {
      setState(await getSubtitlePresentationState());
    } catch (error) {
      setState(null);
      throw error;
    }
  };

  const act = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setNotice("");
    try {
      await operation();
      await refresh();
    } catch (error) {
      setState(null);
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleLock = async (): Promise<void> => {
    if (!state) return;
    setBusy(true);
    setNotice("");
    try {
      const next = await setSubtitleLocked(!state.locked);
      setState(next);
      setNotice(
        next.locked
          ? t("Subtitle locked: clicks pass through.")
          : t("Subtitle unlocked: drag it to reposition.")
      );
    } catch (error) {
      setState(null);
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="yuvi-card grid gap-3" aria-label={t("Subtitle window")}>
      <div>
        <h2 className="m-0 text-lg font-semibold">{t("Subtitle window")}</h2>
        <p className="mb-0 mt-1 text-sm text-[var(--yuvi-muted)]">
          {t(
            "Transparent text stays above other windows. Unlock to drag it, then lock for click-through."
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="button-primary text-xs"
          disabled={busy}
          onClick={() => void act(() => controlSubtitleWindow("show"))}
        >
          {t("Show subtitle")}
        </button>
        <button
          type="button"
          className="button-secondary text-xs"
          disabled={busy}
          onClick={() => void act(() => controlSubtitleWindow("hide"))}
        >
          {t("Hide subtitle")}
        </button>
        <button
          type="button"
          className="button-secondary text-xs"
          disabled={busy || state === null}
          aria-pressed={state?.locked}
          onClick={() => void toggleLock()}
        >
          {state?.locked ? t("Unlock to move") : t("Lock & click through")}
        </button>
      </div>
      <div className="text-xs text-[var(--yuvi-muted)]" role="status">
        {state
          ? t(
              "Subtitle status: {0} · {1}",
              state.visible ? t("visible") : t("hidden"),
              state.locked ? t("locked") : t("unlocked")
            )
          : t("Subtitle status: unavailable")}
        {notice ? ` · ${notice}` : ""}
      </div>
    </section>
  );
}
