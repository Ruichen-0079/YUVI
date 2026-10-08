import { spawn } from "node:child_process";
import { access, chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { isAbsolute, join } from "node:path";

type App = "qq" | "snowluma";
type Options = {
  qqPath?: string | undefined;
  snowlumaDirectory?: string | undefined;
  stateDirectory: string;
  isConnected?: () => boolean;
};

/** Fixed operator-selected local applications only. No shell or browser-supplied commands. */
export class PlungeDesktopApps {
  private pending = new Map<App, Promise<{ started: boolean; url?: string }>>();
  private lastQQOpen = 0;
  constructor(private readonly options: Options) {}

  async snapshot() {
    return {
      qq: { configured: await available(this.options.qqPath, constants.X_OK) },
      snowluma: {
        configured: await available(this.snowEntry()),
        url: await this.findSnowUI()
      }
    };
  }

  open(app: App) {
    const pending = this.pending.get(app);
    if (pending) return pending;
    const next = this.openOnce(app).finally(() => this.pending.delete(app));
    this.pending.set(app, next);
    return next;
  }

  private snowEntry() {
    const dir = this.options.snowlumaDirectory;
    return dir && isAbsolute(dir) ? join(dir, "index.mjs") : undefined;
  }

  private async openOnce(app: App): Promise<{ started: boolean; url?: string }> {
    if (app === "qq") {
      if (!(await available(this.options.qqPath, constants.X_OK))) throw Error("QQ_PATH_REQUIRED");
      // QQ's native single-instance activation brings an existing client forward.
      if (Date.now() - this.lastQQOpen < 3000) return { started: false };
      await this.launch(this.options.qqPath!, [], "qq");
      this.lastQQOpen = Date.now();
      return { started: true };
    }
    const url = await this.findSnowUI();
    if (url) return { started: false, url };
    const entry = this.snowEntry();
    if (!(await available(entry))) throw Error("SNOWLUMA_DIRECTORY_REQUIRED");
    if (this.options.isConnected?.() || (await this.snowProcessAlive()))
      throw Error("SNOWLUMA_RUNNING_UI_UNAVAILABLE");
    const pid = await this.launch(
      process.execPath,
      [entry!],
      "snowluma",
      this.options.snowlumaDirectory
    );
    await writeFile(join(this.options.stateDirectory, "snowluma.pid"), String(pid), {
      mode: 0o600
    });
    for (let i = 0; i < 15; i++) {
      const ready = await this.findSnowUI();
      if (ready) return { started: true, url: ready };
      if (!(await this.snowProcessAlive())) throw Error("SNOWLUMA_START_FAILED_CHECK_LOG");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw Error("SNOWLUMA_STARTING_CHECK_LOG");
  }

  private async snowProcessAlive() {
    try {
      const pid = Number(await readFile(join(this.options.stateDirectory, "snowluma.pid"), "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async launch(executable: string, args: string[], name: App, cwd?: string) {
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    const logPath = join(this.options.stateDirectory, `${name}.log`);
    const log = await open(logPath, "a", 0o600);
    await chmod(logPath, 0o600);
    // Do not pass the management token, Alice credentials or diagnostic Node preload to apps.
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "LANG",
      "LC_ALL",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "DBUS_SESSION_BUS_ADDRESS",
      "XAUTHORITY"
    ])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    try {
      return await new Promise<number>((resolve, reject) => {
        const child = spawn(executable, args, {
          cwd,
          env,
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          shell: false
        });
        child.once("error", () => reject(Error("APPLICATION_START_FAILED_CHECK_LOG")));
        child.once("spawn", () => {
          child.unref();
          resolve(child.pid!);
        });
      });
    } finally {
      await log.close();
    }
  }

  private async findSnowUI(): Promise<string | null> {
    if (!(await available(this.snowEntry()))) return null;
    let runtime: { webuiPort?: number; webuiTls?: { enabled?: boolean } } = {};
    try {
      runtime = JSON.parse(
        await readFile(join(this.options.snowlumaDirectory!, "config/runtime.json"), "utf8")
      );
    } catch {
      /* SnowLuma uses defaults when the optional file is absent. */
    }
    const port = runtime.webuiPort ?? 5099;
    if (!Number.isInteger(port) || port < 1 || port > 65525) return null;
    const scheme = runtime.webuiTls?.enabled ? "https" : "http";
    // SnowLuma selects the next available port when its preferred port is occupied.
    const urls = Array.from({ length: 11 }, (_, i) => `${scheme}://127.0.0.1:${port + i}/`);
    const found = await Promise.all(urls.map(async (url) => ((await isSnowUI(url)) ? url : null)));
    return found.find((url) => url !== null) ?? null;
  }
}

async function available(path?: string, mode = constants.R_OK) {
  if (!path || !isAbsolute(path)) return false;
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}
function isSnowUI(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = (url.startsWith("https:") ? httpsGet : httpGet)(url, (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        resolve(false);
        return;
      }
      let content = "";
      response.setEncoding("utf8");
      response.on("data", (data: string) => {
        content += data;
        if (/<title>[^<]*SnowLuma[^<]*<\/title>/i.test(content)) {
          response.destroy();
          resolve(true);
          return;
        }
        if (content.length > 65536) {
          response.destroy();
          resolve(false);
        }
      });
      response.on("end", () => resolve(/<title>[^<]*SnowLuma[^<]*<\/title>/i.test(content)));
      response.on("error", () => resolve(false));
    });
    req.setTimeout(700, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}
