import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  realpathSync,
  openSync,
  closeSync,
  unlinkSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
const root = dirname(fileURLToPath(import.meta.url)),
  state = join(root, "state");
mkdirSync(state, { recursive: true, mode: 0o700 });
chmodSync(state, 0o700);
const args = process.argv.slice(2),
  values = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--character", "--plunge", "--port"].includes(args[i]) || !args[i + 1])
    throw Error(
      "Usage: ./start.sh --character /absolute/alice.json --plunge /absolute/plunge.json [--port 6135]"
    );
  values[args[i].slice(2)] = args[i + 1];
}
const deploymentPath = join(state, "deployment.json");
const previous = existsSync(deploymentPath) ? JSON.parse(readFileSync(deploymentPath, "utf8")) : {};
const deployment = { ...previous, ...values };
if (!deployment.character || !deployment.plunge)
  throw Error(
    "首次启动请指定现有独立 Alice composition 和 Plunge 配置：./start.sh --character /absolute/alice.json --plunge /absolute/plunge.json"
  );
deployment.character = realpathSync(resolve(deployment.character));
deployment.plunge = realpathSync(resolve(deployment.plunge));
const port = Number(deployment.port ?? 6135);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid port");
const character = JSON.parse(readFileSync(deployment.character, "utf8"));
if (character.definition?.id !== "alice")
  throw Error("Requires the existing independent Alice composition");
// One operator per Character. The runtime retains its existing file/database ownership checks.
const lock = join(character.envDirectory, "plunge-webui.pid");
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, "utf8"));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {}
  if (alive) throw Error("This Alice WebUI launcher is already running");
  unlinkSync(lock);
}
const fd = openSync(lock, "wx", 0o600);
writeFileSync(fd, String(process.pid));
closeSync(fd);
const tokenPath = join(state, "admin-token");
if (!existsSync(tokenPath))
  writeFileSync(tokenPath, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
chmodSync(tokenPath, 0o600);
const token = readFileSync(tokenPath, "utf8").trim();
if (token.length < 32) throw Error("Invalid admin-token");
writeFileSync(deploymentPath, JSON.stringify({ ...deployment, port }, null, 2) + "\n", {
  mode: 0o600
});
chmodSync(deploymentPath, 0o600);
const logPath = join(state, "alice.log"),
  log = openSync(logPath, "a", 0o600);
chmodSync(logPath, 0o600);
const child = spawn(process.execPath, [join(root, "runtime", "plunge.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    YUVI_CHARACTER_CONFIG_PATH: deployment.character,
    YUVI_PLUNGE_CONFIG_PATH: deployment.plunge,
    YUVI_PLUNGE_WEBUI_DIR: join(root, "webui"),
    YUVI_PLUNGE_WEBUI_PORT: String(port),
    DASHBOARD_DEV_TOKEN: token
  },
  stdio: ["ignore", log, log]
});
console.log(
  `Alice / Plunge WebUI: http://127.0.0.1:${port}/plunge\n管理令牌：${tokenPath}\n私有日志：${logPath}\n部署路径已保存，下次直接运行 ./start.sh。关闭时按 Ctrl+C。`
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  closeSync(log);
  try {
    unlinkSync(lock);
  } catch {}
  process.exitCode = code ?? 1;
});
