import { NativeActivation } from "./native-activation.js";
import { fetchUserSettings } from "./user-settings-client.js";
import { waitDesktopBinding } from "./wait-desktop-binding.js";
import {
  getDesktopRuntimeBinding,
  retryDesktopRuntimeBinding
} from "./service-supervisor-client.js";
import { isTauriRuntime } from "./tauri-window.js";
import { initializeLocale, setLocale, LOCALE_STORAGE_KEY } from "./locale.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ProductWebUI } from "./product-webui.js";
import { MainPage } from "./main-page.js";
import { CompanionPage } from "./companion-page.js";
import { SubtitlePage } from "./subtitle-page.js";
import {
  resolveDesktopSurface,
  setDesktopRuntimeBinding,
  type DesktopRuntimeBindingMode,
  type DesktopSurface
} from "./desktop-runtime.js";
import "./styles.css";
import "./product-ui.css";
import "./typography.css";

/**
 * Lightweight surface routing for the desktop split.
 * Tauri windows prefer window label (main/companion); hash is a browser fallback.
 */
function renderSurface(surface: DesktopSurface): JSX.Element {
  switch (surface) {
    case "main":
      return <MainPage />;
    case "companion":
      return <CompanionPage />;
    case "subtitle":
      return <SubtitlePage />;
    case "webui":
      return <ProductWebUI />;
    case "dashboard":
      return <App />;
  }
}

function RuntimeBindingUnavailable({
  detail,
  waiting = false
}: {
  detail: string;
  waiting?: boolean;
}): JSX.Element {
  return (
    <main className="runtime-binding-unavailable" role="alert">
      <div className="runtime-binding-unavailable__card">
        <h1>{waiting ? "YUVI is starting" : "YUVI Runtime unavailable"}</h1>
        <p>
          {waiting
            ? "Waiting for this instance's services to become ready."
            : "This desktop instance could not verify its own Runtime binding. No other local YUVI Runtime will be used as a fallback."}
        </p>
        <p className="runtime-binding-unavailable__detail">{detail}</p>
        <button
          className="button-primary"
          type="button"
          disabled={waiting}
          onClick={() => {
            void retryDesktopRuntimeBinding().finally(() => window.location.reload());
          }}
        >
          Retry
        </button>
      </div>
    </main>
  );
}

initializeLocale();
window.addEventListener("storage", (event) => {
  if (event.key === LOCALE_STORAGE_KEY) window.location.reload();
});

const rootElement = document.getElementById("root") as HTMLElement;
const root = createRoot(rootElement);

void resolveDesktopSurface().then(async (surface) => {
  document.documentElement.dataset["yuviSurface"] = surface;
  if (isTauriRuntime()) {
    let bindingMode: DesktopRuntimeBindingMode = "attach";
    try {
      const binding = await waitDesktopBinding(getDesktopRuntimeBinding, (detail) => {
        root.render(<RuntimeBindingUnavailable detail={detail} waiting />);
      });
      if (!binding) throw new Error("Desktop Runtime binding projection is unavailable.");
      bindingMode = binding.mode;
      setDesktopRuntimeBinding(binding.mode, binding.ready ? binding.runtimeUrl : null);
      if (!binding.ready || !binding.runtimeUrl) {
        root.render(
          <StrictMode>
            <RuntimeBindingUnavailable
              detail={
                binding.error ?? "The bound Supervisor/Runtime identity could not be verified."
              }
            />
          </StrictMode>
        );
        return;
      }
    } catch (error) {
      setDesktopRuntimeBinding(bindingMode, null);
      root.render(
        <StrictMode>
          <RuntimeBindingUnavailable
            detail={error instanceof Error ? error.message : "Runtime binding failed."}
          />
        </StrictMode>
      );
      return;
    }
    try {
      const view = await fetchUserSettings();
      setLocale(view.settings.app.language === "en" ? "en" : "zh-CN");
    } catch {
      /* Settings surfaces expose load errors; the local UI remains usable. */
    }
  }
  root.render(
    <StrictMode>
      {isTauriRuntime() && (surface === "main" || surface === "webui") ? (
        <NativeActivation>{renderSurface(surface)}</NativeActivation>
      ) : (
        renderSurface(surface)
      )}
    </StrictMode>
  );
});
