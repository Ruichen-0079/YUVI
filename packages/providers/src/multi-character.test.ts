import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProviderRegistryFromEnv,
  ProviderRegistry,
  createProviderRegistryConfigFromEnv
} from "./registry.js";
import { withProviderWorkContext, type ProviderAccountingPort } from "./accounting.js";

const owners: { owner: string; scope: string | undefined }[] = [];
const accounting = (owner: string): ProviderAccountingPort => ({
  async invoke(task, _leaf, call, signal) {
    owners.push({ owner, scope: task.context?.scope });
    return call(signal);
  },
  async *stream(task, _leaf, call, signal) {
    owners.push({ owner, scope: task.context?.scope });
    yield* call(signal);
  }
});
const service = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  const input = JSON.parse(body);
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      id: "shared-serving-request",
      object: "chat.completion",
      model: "shared-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "served " + input.messages.at(-1).content },
          finish_reason: "stop"
        }
      ]
    })
  );
});
let endpoint: string;
function env(baseUrl: string) {
  return {
    NODE_ENV: "test",
    PROVIDER_ALLOW_MOCKS: "false",
    DEFAULT_CHAT_PROVIDER: "local",
    CHAT_PROVIDER_CHAIN: "local",
    LOCAL_MODEL_BASEURL: baseUrl,
    LOCAL_CHAT_MODEL: "shared-model"
  };
}
async function prove(baseUrl: string) {
  owners.length = 0;
  const a = createProviderRegistryFromEnv(env(baseUrl)),
    b = createProviderRegistryFromEnv(env(baseUrl));
  a.setAccounting(accounting("yuvi"));
  b.setAccounting(accounting("alice"));
  a.bindCharacterOwner("yuvi.production");
  b.bindCharacterOwner("alice.production");
  expect(() => a.bindCharacterOwner("alice.production")).toThrow(/another Character/);
  expect(() => a.setAccounting(accounting("alice"))).toThrow(/accounting owner/);
  const outputs = await Promise.all(
    [a, b].map((registry, index) =>
      withProviderWorkContext({ scope: "same-session", executionId: "execution-" + index }, () =>
        registry.getChatProvider().generateReply({
          messages: [{ role: "user", content: "Reply with only OK." }],
          maxTokens: 16
        })
      )
    )
  );
  expect(outputs.every((output) => output.message.content.trim().length > 0)).toBe(true);
  expect(owners.map((entry) => entry.owner).sort()).toEqual(["alice", "yuvi"]);
  expect(owners.every((entry) => entry.scope === "same-session")).toBe(true);
}
describe("independent Registry ownership with shared inference serving", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    endpoint = "http://127.0.0.1:" + (service.address() as { port: number }).port + "/v1";
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      service.close((error) => (error ? reject(error) : resolve()))
    );
  });
  it("shares a real HTTP endpoint without switching accounting owner", async () => {
    await prove(endpoint);
  });
  it("does not mutate shared bootstrap configuration when accounting is installed", () => {
    const config = createProviderRegistryConfigFromEnv(env(endpoint));
    const a = new ProviderRegistry(config),
      b = new ProviderRegistry(config);
    a.setAccounting(accounting("yuvi"));
    b.setAccounting(accounting("alice"));
    expect(config.accounting).toBeUndefined();
    expect(config.accountingConfigurationRef).toBeUndefined();
  });
  it("rejects sharing one owner-bound accounting adapter through two otherwise independent Registries", () => {
    const shared = accounting("yuvi");
    const a = createProviderRegistryFromEnv(env(endpoint)),
      b = createProviderRegistryFromEnv(env(endpoint));
    a.setAccounting(shared);
    b.setAccounting(shared);
    a.bindCharacterOwner("yuvi.production");
    expect(() => b.bindCharacterOwner("alice.production")).toThrow(/accounting adapter belongs/);
  });
  it.skipIf(!process.env["YUVI_MULTI_CHARACTER_MODEL_BASE_URL"])(
    "uses one actual local model process for both Characters",
    async () => {
      await prove(process.env["YUVI_MULTI_CHARACTER_MODEL_BASE_URL"]!);
    },
    120_000
  );
});
