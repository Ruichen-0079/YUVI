import { useEffect, useState } from "react";
import { t } from "./locale.js";
import {
  controlCompanionWindow,
  setCompanionLocked,
  getCompanionPresentationState,
  isTauriRuntime,
  subscribeSurfaceChanged,
  type CompanionPresentationState
} from "./tauri-window.js";
import { fetchUserSettings, saveUserSettings } from "./user-settings-client.js";
import {
  CompanionPresentationProjectionChannel,
  type CompanionRendererPresentation,
  type Live2DRendererStatus
} from "./companion-presentation-projection.js";

export function companionAlwaysOnTopPatch(alwaysOnTop: boolean): Record<string, unknown> {
  return { companion: { alwaysOnTop } };
}

function rendererStatusLabel(status: Live2DRendererStatus): string {
  switch (status) {
    case "no_model":
      return "no model";
    case "loading":
      return "loading";
    case "ready":
      return "ready";
    case "failed":
      return "failed";
  }
}

/**
 * Thin Appearance projection over the existing desktop and renderer authorities.
 * Window visibility is read from DesktopSurfaceManager; Live2D readiness is only
 * reported by the live Companion renderer lifecycle.
 */
export function CompanionAppearanceSettings(): JSX.Element | null {
  const tauri = isTauriRuntime();
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [loading, setLoading] = useState(tauri);
  const [saving, setSaving] = useState(false);
  const [windowBusy, setWindowBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [surface, setSurface] = useState<CompanionPresentationState>({ visible: false, locked: false });
  const [renderer, setRenderer] = useState<CompanionRendererPresentation | null>(null);

  useEffect(() => {
    if (!tauri) return;
    let cancelled = false;
    setLoading(true);
    void fetchUserSettings()
      .then((view) => {
        if (!cancelled) {
          setAlwaysOnTop(view.settings.companion.alwaysOnTop);
          setNotice("");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tauri]);

  useEffect(() => {
    if (!tauri) return;
    let cancelled = false;
    const refreshSurface = async (): Promise<void> => {
      try {
        const next = await getCompanionPresentationState();
        if (!cancelled)
          setSurface((current) => (current.visible === next.visible && current.locked === next.locked ? current : next));
      } catch (error) {
        if (!cancelled) setNotice(error instanceof Error ? error.message : String(error));
      }
    };

    const channel = new CompanionPresentationProjectionChannel();
    const unsubscribe = channel.subscribeState((next) => {
      if (!cancelled)
        setRenderer((current) =>
          current?.status === next.status &&
          current.activeModelId === next.activeModelId &&
          current.activeModelName === next.activeModelName
            ? current
            : next
        );
    });
    channel.requestState();
    void refreshSurface();

    const stopSurface = subscribeSurfaceChanged(
      () => void refreshSurface(),
      (error) => {
        if (!cancelled) setNotice(String(error));
      }
    );
    const rendererDeadline = window.setTimeout(() => {
      if (!cancelled) {
        setRenderer(
          (current) => current ?? { status: "failed", activeModelId: null, activeModelName: null }
        );
      }
    }, 1500);

    return () => {
      cancelled = true;
      stopSurface();
      window.clearTimeout(rendererDeadline);
      unsubscribe();
      channel.close();
    };
  }, [tauri]);

  if (!tauri) return null;

  const save = async (): Promise<void> => {
    setSaving(true);
    setNotice("");
    try {
      const result = await saveUserSettings(companionAlwaysOnTopPatch(alwaysOnTop));
      setAlwaysOnTop(result.settings.companion.alwaysOnTop);
      setNotice(t("Companion window setting saved."));
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : t("Unable to save Companion window setting.")
      );
    } finally {
      setSaving(false);
    }
  };

  const controlWindow = async (action: "show_companion" | "hide_companion"): Promise<void> => {
    setWindowBusy(true);
    setNotice("");
    try {
      await controlCompanionWindow(action);
      setSurface(await getCompanionPresentationState());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setWindowBusy(false);
    }
  };

  const modelLabel =
    renderer?.activeModelName ??
    (renderer?.status === "no_model" ? t("No model selected") : t("Unknown"));
  const rendererLabel = t(rendererStatusLabel(renderer?.status ?? "loading"));

  return (
    <section className="yuvi-card grid gap-3" aria-label={t("Companion window")}>
      <div>
        <h2 className="m-0 text-lg font-semibold">{t("Companion window")}</h2>
        <p className="mb-0 mt-1 text-sm text-[var(--yuvi-muted)]">
          {t("The transparent Live2D window remembers its position and size automatically.")}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="button-primary text-xs"
          disabled={windowBusy}
          onClick={() => void controlWindow("show_companion")}
        >
          {t("Show Companion")}
        </button>
        <button
          type="button"
          className="button-secondary text-xs"
          disabled={windowBusy}
          onClick={() => void controlWindow("hide_companion")}
        >
          {t("Hide Companion")}
        </button>
      </div>

      <div className="grid gap-1 text-xs text-[var(--yuvi-muted)]" role="status">
        <span>{t("Companion status: {0}", surface.visible ? t("visible") : t("hidden"))}</span>
        <span>{t("Current model: {0}", modelLabel)}</span>
        <span>{t("Live2D renderer: {0}", rendererLabel)}</span>
      </div>

      <button type="button" className="button-secondary" disabled={windowBusy}
        onClick={() => {
          setWindowBusy(true);
          void setCompanionLocked(!surface.locked).then(setSurface)
            .catch((error: unknown) => setNotice(String(error)))
            .finally(() => setWindowBusy(false));
        }}>
        {t(surface.locked ? "Unlock Companion" : "Lock Companion")}
      </button>
      <label className="setting-checkbox">
        <input
          type="checkbox"
          checked={alwaysOnTop}
          disabled={loading || saving}
          onChange={(event) => setAlwaysOnTop(event.target.checked)}
        />
        {t("Always on top")}
      </label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="button-primary text-xs"
          disabled={loading || saving}
          onClick={() => void save()}
        >
          {saving ? t("Saving…") : t("Save window setting")}
        </button>
        {notice ? (
          <span className="text-xs text-[var(--yuvi-muted)]" role="status">
            {notice}
          </span>
        ) : null}
      </div>
    </section>
  );
}
