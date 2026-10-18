import { ProductAuthorityMemory } from "./product-authority-memory.js";
import { productDestinations as destinations, type ProductView } from "./product-navigation.js";
import { LocaleSelector } from "./locale-selector.js";
import { t } from "./locale.js";
import { ProductLive2DModels } from "./product-live2d-models.js";
import { ProductVisionStatus } from "./product-vision-status.js";
import { useEffect, useRef, useState } from "react";
import { App as DeveloperDashboard } from "./App.js";
import { apiClient } from "./api/client.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { ProductCompactHealth, productCompactHealthItems } from "./product-compact-health.js";
import { ProductMemorySettings } from "./product-memory-settings.js";
import { ProductConfigurationPanel } from "./product-configuration.js";
import { ProductLocalServicesPanel } from "./product-local-services.js";
import { isTauriRuntime } from "./tauri-window.js";
import { UserSettingsPanel } from "./user-settings-panel.js";
import { CompanionAppearanceSettings } from "./companion-appearance-settings.js";
import { SubtitleAppearanceSettings } from "./subtitle-appearance-settings.js";
import { ProductFirstRunSetup } from "./product-first-run-setup.js";

/** Navigation is presentation state; settings remain with their existing owners. */
export function ProductWebUI(): JSX.Element {
  const contentRef = useRef<HTMLElement>(null);
  const [view, setView] = useState<ProductView>("home");
  const health = useAsyncData((signal) => apiClient.getHealth(signal), []);
  const tauri = isTauriRuntime();
  const destination = destinations.find((item) => item.id === view) ?? destinations[0]!;
  const status = t(
    productCompactHealthItems({
      health: health.data,
      loading: health.loading,
      error: health.error
    })[0]?.summary ?? "Unknown"
  );
  useEffect(() => {
    window.scrollTo?.(0, 0);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [view]);
  const navigate = (next: ProductView) => setView(next);
  if (view === "developer")
    return (
      <>
        <button
          type="button"
          className="yuvi-developer-return"
          onClick={() => navigate("advanced")}
        >
          {t("← Product WebUI")}
        </button>
        <DeveloperDashboard />
      </>
    );

  return (
    <div className="yuvi-shell yuvi-product-webui">
      <a
        className="yuvi-skip-link"
        href="#product-content"
        onClick={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
      >
        {t("Skip to settings")}
      </a>
      <aside className="yuvi-product-sidebar">
        <div className="yuvi-product-brand">
          <span aria-hidden="true" className="yuvi-brand-mark">
            y
          </span>
          <div>
            <strong>YUVI</strong>
            <span>{t("Companion Control")}</span>
          </div>
        </div>
        <nav aria-label={t("Settings navigation")}>
          {destinations.map((item, index) => (
            <div key={item.id}>
              {item.group !== destinations[index - 1]?.group && (
                <div className="yuvi-nav-group">{t(item.group)}</div>
              )}
              <button
                type="button"
                aria-current={view === item.id ? "page" : undefined}
                className="yuvi-nav-item"
                onClick={() => navigate(item.id)}
              >
                {t(item.label)}
              </button>
            </div>
          ))}
        </nav>
        <button
          type="button"
          className="yuvi-sidebar-status"
          onClick={() => void health.refresh()}
          disabled={health.loading}
          title={t("Refresh product status")}
        >
          <span>{t("Runtime")}</span>
          <strong>{status}</strong>
        </button>
      </aside>
      <main ref={contentRef} id="product-content" className="yuvi-product-content" tabIndex={-1}>
        <header className="yuvi-page-heading">
          <div className="yuvi-product-eyebrow">{t(destination.group)}</div>
          <h1>{t(destination.label)}</h1>
          <p>{t(destination.description)}</p>
        </header>
        <div key={view} className="yuvi-page-body">
          {view === "home" && (
            <>
              <ProductFirstRunSetup
                onNavigate={(next) => navigate(next === "advanced" ? "models" : "appearance")}
              />
              <ProductCompactHealth
                health={health.data}
                loading={health.loading}
                error={health.error}
                onRefresh={() => void health.refresh()}
              />
              {health.error && (
                <div className="yuvi-product-inline-state is-warning" role="status">
                  {t(
                    health.data
                      ? "Showing the last successful Runtime projection."
                      : "Runtime health unavailable"
                  )}
                </div>
              )}
              <section className="yuvi-overview-links" aria-label={t("Personalize")}>
                {destinations
                  .filter((item) => ["models", "appearance", "people"].includes(item.id))
                  .map((item) => (
                    <button type="button" key={item.id} onClick={() => navigate(item.id)}>
                      <strong>
                        {t(item.label)} <span aria-hidden="true">↗</span>
                      </strong>
                      <span>{t(item.description)}</span>
                    </button>
                  ))}
              </section>
              {!tauri && (
                <div className="yuvi-product-actions">
                  <a className="yuvi-product-action" href="/#/main" target="yuvi-main">
                    {t("Chat & Voice Mode")}
                  </a>
                  <a className="yuvi-product-action" href="/#/companion" target="yuvi-companion">
                    {t("Companion")}
                  </a>
                  <a className="yuvi-product-action" href="/#/subtitle" target="yuvi-subtitle">
                    {t("Subtitle")}
                  </a>
                </div>
              )}
            </>
          )}
          {view === "models" && (
            <>
              <ProductLocalServicesPanel />
              <details className="yuvi-advanced">
                <summary>{t("Advanced provider settings")}</summary>
                <ProductConfigurationPanel sections={["providers", "models", "routes"]} />
              </details>
            </>
          )}
          {view === "people" && <ProductConfigurationPanel sections={["people", "voices"]} />}
          {view === "behavior" && (
            <>
              {tauri && <UserSettingsPanel sections={["speech", "proactive"]} />}
              <ProductConfigurationPanel sections={["proactive"]} />
            </>
          )}
          {view === "memory" &&
            (health.error || !health.data?.memory ? (
              <p role="status">Memory 服务状态不可用；请刷新 Runtime 状态后重试。</p>
            ) : health.data.memory.backend === "postgres-authority" ? (
              <ProductAuthorityMemory />
            ) : health.data.memory.backend === "legacy" ? (
              tauri ? (
                <UserSettingsPanel sections={["memory"]} />
              ) : (
                <ProductMemorySettings />
              )
            ) : (
              <p role="status">Memory 服务类型未识别。</p>
            ))}
          {view === "appearance" && (
            <>
              <CompanionAppearanceSettings />
              <ProductLive2DModels />
            </>
          )}
          {view === "subtitle" &&
            (tauri ? (
              <SubtitleAppearanceSettings />
            ) : (
              <p className="yuvi-product-inline-state">
                {t(
                  "Window controls are available in the YUVI desktop app. Use the tray to show or hide this window."
                )}
              </p>
            ))}
          {view === "vision" && <ProductVisionStatus />}
          {view === "advanced" && (
            <>
              <LocaleSelector />
              <details className="yuvi-advanced">
                <summary>{t("Connection troubleshooting")}</summary>
                <ProductConfigurationPanel sections={["status"]} />
              </details>
              <section className="yuvi-system-tools">
                <h2>{t("Developer tools")}</h2>
                <p>{t("Inspect events, prompts, and detailed runtime diagnostics.")}</p>
                <button
                  className="yuvi-product-button"
                  type="button"
                  onClick={() => navigate("developer")}
                >
                  {t("Open developer console")}
                </button>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
