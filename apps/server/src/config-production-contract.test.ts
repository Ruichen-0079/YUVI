import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const program = `
import {readFileSync} from 'node:fs';
import {parseRuntimeConfig} from './packages/config/src/index.ts';
import {createProviderRegistryConfigFromEnv} from './packages/providers/src/index.ts';
import {deriveConfigFromEnv} from './packages/desktop-supervisor/src/config.ts';
import {loadServerConfig} from './apps/server/src/config.ts';
import {parseMemoryRepositoryEnv} from './packages/memory/src/env.ts';
import {parseConversationRepositoryEnv} from './packages/memory/src/conversation-repository.ts';
const {env, root}=JSON.parse(readFileSync(0,'utf8'));
const r=parseRuntimeConfig(env), p=createProviderRegistryConfigFromEnv(env), s=deriveConfigFromEnv(root,env), h=loadServerConfig(env);
if(parseMemoryRepositoryEnv(env).kind!==r.memory.repository || parseConversationRepositoryEnv(env).kind!==r.memory.repository) throw Error('storage factory differs from configuration');
console.log(JSON.stringify({runtime:r.memory.backend,supervisor:s.memoryBackend,repository:r.memory.repository,mem0:s.autostartMem0,mocks:[r.providers.allowMocks,p.allowMocks],modes:[r.environment,p.environment,h.runtimeMode],ports:[r.server.port,h.port]}));
`;

it("uses the same storage, mock and mode semantics across actual Runtime/Provider/Server/Supervisor imports in a child process", () => {
  const root = mkdtempSync(join(tmpdir(), "yuvi-config-contract-"));
  try {
    for (const backend of [undefined, "legacy", " MeM0 ", " Postgres "]) {
      const env = {
        NODE_ENV: " TeSt ",
        SERVER_PORT: "0",
        MEMORY_BACKEND: backend,
        MEMORY_REPOSITORY: " POSTGRES ",
        PROVIDER_ALLOW_MOCKS: " ON ",
        YUVI_AUTOSTART_MEM0: "true",
        YUVI_MEM0_SKIP_INTERPRETER_PREFLIGHT: "1"
      };
      const output = execFileSync(
        process.execPath,
        ["--conditions=development", "--import", "tsx", "--input-type=module", "-e", program],
        {
          cwd: new URL("../../../", import.meta.url),
          env: { PATH: process.env["PATH"] },
          input: JSON.stringify({ env, root }),
          encoding: "utf8"
        }
      );
      const actual = JSON.parse(output);
      const expected = backend?.trim().toLowerCase() ?? "legacy";
      expect(actual).toEqual({
        runtime: expected,
        supervisor: expected,
        repository: "postgres",
        mem0: expected === "mem0",
        mocks: [true, true],
        modes: ["test", "test", "test"],
        ports: [0, 0]
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
