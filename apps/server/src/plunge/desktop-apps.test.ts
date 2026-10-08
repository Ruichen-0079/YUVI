import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { PlungeDesktopApps } from "./desktop-apps.js";

const roots: string[] = [],
  servers: Server[] = [],
  pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid);
    } catch {}
  }
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "plunge-desktop-"));
  roots.push(root);
  const snow = join(root, "SnowLuma");
  await mkdir(join(snow, "config"), { recursive: true });
  await writeFile(join(snow, "index.mjs"), "");
  return { root, snow };
}
async function listen(server: Server, port = 0) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return (server.address() as { port: number }).port;
}
describe("fixed local QQ / SnowLuma opening", () => {
  it("rejects missing or relative executable paths instead of accepting a command", async () => {
    const { root } = await fixture();
    const apps = new PlungeDesktopApps({ stateDirectory: root, qqPath: "echo injected" });
    expect((await apps.snapshot()).qq.configured).toBe(false);
    await expect(apps.open("qq")).rejects.toThrow("QQ_PATH_REQUIRED");
    await expect(apps.open("snowluma")).rejects.toThrow("SNOWLUMA_DIRECTORY_REQUIRED");
  });
  it("opens an existing SnowLuma fallback port without starting another process or following redirects", async () => {
    const { root, snow } = await fixture();
    const other = createServer((_req, res) => {
      res.writeHead(302, { location: "http://attacker.example" });
      res.end();
    });
    const base = await listen(other);
    const snowServer = createServer((_req, res) =>
      res.end("<title>SnowLuma 控制台</title>" + "x".repeat(80000))
    );
    await listen(snowServer, base + 1);
    await writeFile(join(snow, "config/runtime.json"), JSON.stringify({ webuiPort: base }));
    const apps = new PlungeDesktopApps({
      stateDirectory: root,
      snowlumaDirectory: snow,
      isConnected: () => true
    });
    expect(await apps.open("snowluma")).toEqual({
      started: false,
      url: `http://127.0.0.1:${base + 1}/`
    });
    await expect(readFile(join(root, "snowluma.pid"))).rejects.toThrow();
  });
  it("never starts a second SnowLuma while QQ is already connected and its UI is unavailable", async () => {
    const { root, snow } = await fixture();
    await writeFile(join(snow, "config/runtime.json"), JSON.stringify({ webuiPort: 0 }));
    const apps = new PlungeDesktopApps({
      stateDirectory: root,
      snowlumaDirectory: snow,
      isConnected: () => true
    });
    await expect(apps.open("snowluma")).rejects.toThrow("SNOWLUMA_RUNNING_UI_UNAVAILABLE");
    await expect(readFile(join(root, "snowluma.pid"))).rejects.toThrow();
  });
  it("coalesces concurrent QQ launches, treats paths literally, and does not pass Alice secrets or Node preload", async () => {
    const { root } = await fixture();
    const qq = join(root, "QQ ; literal.AppImage"),
      marker = join(root, "result.json");
    await writeFile(
      qq,
      `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2), token:process.env["DASHBOARD_DEV_TOKEN"], preload:process.env["NODE_OPTIONS"]}));\n`,
      { mode: 0o755 }
    );
    const saved = {
      token: process.env["DASHBOARD_DEV_TOKEN"],
      preload: process.env["NODE_OPTIONS"]
    };
    process.env["DASHBOARD_DEV_TOKEN"] = "private-token";
    process.env["NODE_OPTIONS"] = "--invalid-for-child";
    try {
      const apps = new PlungeDesktopApps({ stateDirectory: root, qqPath: qq });
      const results = await Promise.all(Array.from({ length: 8 }, () => apps.open("qq")));
      expect(results.every((r) => r === results[0])).toBe(true);
      for (let i = 0; i < 50; i++) {
        try {
          await readFile(marker);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ args: [] });
      expect(await apps.open("qq")).toEqual({ started: false });
    } finally {
      if (saved.token === undefined) delete process.env["DASHBOARD_DEV_TOKEN"];
      else process.env["DASHBOARD_DEV_TOKEN"] = saved.token;
      if (saved.preload === undefined) delete process.env["NODE_OPTIONS"];
      else process.env["NODE_OPTIONS"] = saved.preload;
    }
  });
  it("starts an unavailable SnowLuma once and opens its actual local UI", async () => {
    const { root, snow } = await fixture();
    const probe = createServer();
    const port = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    servers.splice(servers.indexOf(probe), 1);
    await writeFile(join(snow, "config/runtime.json"), JSON.stringify({ webuiPort: port }));
    await writeFile(
      join(snow, "index.mjs"),
      `import {createServer} from 'node:http';createServer((_req,res)=>res.end('<title>SnowLuma fixture</title>')).listen(${port},'127.0.0.1');`
    );
    const apps = new PlungeDesktopApps({ stateDirectory: root, snowlumaDirectory: snow });
    try {
      const results = await Promise.all([apps.open("snowluma"), apps.open("snowluma")]);
      expect(results[0]).toEqual({ started: true, url: `http://127.0.0.1:${port}/` });
      expect(results[1]).toBe(results[0]);
      expect(await apps.open("snowluma")).toEqual({
        started: false,
        url: `http://127.0.0.1:${port}/`
      });
    } finally {
      try {
        pids.push(Number(await readFile(join(root, "snowluma.pid"), "utf8")));
      } catch {}
    }
  });
});
