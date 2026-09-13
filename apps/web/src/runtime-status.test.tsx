import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TopStatusBar } from "./App.js";
import { setDesktopRuntimeBinding } from "./desktop-runtime.js";

afterEach(() => {
  setDesktopRuntimeBinding("owned", null);
  vi.unstubAllGlobals();
});
it("shows the attached packaged Runtime endpoint in the Dashboard", () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  setDesktopRuntimeBinding("attach", "http://127.0.0.1:16121");
  const html = renderToStaticMarkup(
    <TopStatusBar health={null} loading={false} error={null} onRefresh={async () => {}} />
  );
  expect(html).toContain("http://127.0.0.1:16121");
  expect(html).not.toContain(":6121");
});
