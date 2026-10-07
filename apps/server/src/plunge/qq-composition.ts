import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { CharacterComposition } from "../character-composition.js";
import type { HostCharacterSurfaces } from "../character-surface-host.js";
import { QQTransport, type QQTrace } from "./qq-transport.js";

const uin = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const PlungeConfigurationSchema = z
  .object({
    version: z.literal(1),
    deployment: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
    expectedAccount: uin,
    onebotConfigPath: z.string().min(1),
    privatePeers: z.array(uin).max(32),
    groups: z.array(uin).max(32),
    personBindings: z
      .array(z.object({ sender: uin, personId: z.string().min(1).max(256) }).strict())
      .max(64),
    mediaRoots: z.array(z.string().min(1)).max(8)
  })
  .strict();
export type PlungeConfiguration = z.infer<typeof PlungeConfigurationSchema>;

/** Credentials are read into memory from the operator's existing OneBot file. */
export function composePlunge(
  file: string,
  composition: CharacterComposition,
  trace?: (event: QQTrace) => void
) {
  if (composition.binding.definition.id !== "alice")
    throw Error("Plunge requires the independent Alice Character composition.");
  const config = PlungeConfigurationSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (!isAbsolute(config.onebotConfigPath) || config.mediaRoots.some((root) => !isAbsolute(root)))
    throw Error("Plunge storage paths must be absolute.");
  const onebot = JSON.parse(readFileSync(config.onebotConfigPath, "utf8")) as {
    networks?: {
      wsServers?: Array<{
        host?: string;
        port?: number;
        path?: string;
        accessToken?: string;
        enabled?: boolean;
      }>;
    };
  };
  const candidates = onebot.networks?.wsServers?.filter(
    (s) => s.enabled !== false && ["127.0.0.1", "localhost", "::1"].includes(s.host ?? "")
  );
  if (candidates?.length !== 1)
    throw Error("Select exactly one existing authenticated loopback OneBot WS server.");
  const server = candidates[0]!;
  if (
    !Number.isSafeInteger(server.port) ||
    !server.port ||
    server.port < 1 ||
    server.port > 65535 ||
    typeof server.path !== "string" ||
    !server.path.startsWith("/") ||
    /[?#\r\n]/.test(server.path) ||
    typeof server.accessToken !== "string" ||
    !/^[\x21-\x7e]+$/.test(server.accessToken)
  )
    throw Error("Invalid OneBot connection configuration.");
  const endpoint = `ws://${server.host === "::1" ? "[::1]" : server.host}:${server.port}${server.path}`;
  const endpointId = createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
  const namespace = `qq:${config.deployment}:${endpointId}:${config.expectedAccount}`;
  const bindings = new Map<string, string>();
  for (const binding of config.personBindings) {
    if (bindings.has(binding.sender)) throw Error("Duplicate QQ Person binding.");
    if (!composition.people?.readPerson(binding.personId))
      throw Error("QQ binding refers to an unavailable canonical Product Person.");
    bindings.set(binding.sender, binding.personId);
  }
  const bindingVersion =
    "plunge-binding:" +
    createHash("sha256").update(JSON.stringify(config.personBindings)).digest("hex");
  return (host: HostCharacterSurfaces) => {
    const channels = new Set([
      ...config.privatePeers.map((peer) => `${namespace}:private:${peer}`),
      ...config.groups.map((group) => `${namespace}:group:${group}`)
    ]);
    const port = host.bind({
      surfaceId: "qq",
      principalNamespace: namespace,
      selfActorId: config.expectedAccount,
      resolvePerson(actor) {
        const id = bindings.get(actor),
          person = id ? composition.people?.readPerson(id) : null;
        return person
          ? { personId: person.person.id, displayName: person.person.displayName, bindingVersion }
          : null;
      },
      acceptsChannel(channel) {
        if (channels.has(channel)) return true;
        const match = /^(.*):temp:([1-9][0-9]*)$/.exec(channel);
        return !!match && channels.has(match[1]!) && config.groups.includes(match[2]!);
      }
    });
    return [
      new QQTransport(
        {
          endpoint,
          accessToken: server.accessToken!,
          expectedAccount: config.expectedAccount,
          namespace,
          privatePeers: config.privatePeers,
          groups: config.groups,
          mediaRoots: config.mediaRoots
        },
        port,
        trace
      ).source()
    ];
  };
}
