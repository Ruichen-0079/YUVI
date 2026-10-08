import { randomUUID } from "node:crypto";
import type { ChatInput, ChatProvider, ProviderRegistry, ChatOutput } from "@companion/providers";

/** Bounded, process-local copies at the real ChatModel boundary. No persistence or prompt assembly. */
export class PlungeInspector {
  private requests: Array<{
    id: string;
    at: string;
    mode: string;
    provider: string;
    input: ChatInput;
    outcome: string;
    decision?: Record<string, unknown> | undefined;
    errorCode?: string | undefined;
    finalProvider?: string | undefined;
    model?: string | undefined;
  }> = [];
  private observed = new WeakSet<object>();
  observe(registry: ProviderRegistry) {
    const provider: ChatProvider = registry.getChatProvider();
    if (this.observed.has(provider)) return;
    this.observed.add(provider);
    const record = (input: ChatInput, mode: string) => {
      const entry = {
        id: randomUUID(),
        at: new Date().toISOString(),
        mode,
        provider: provider.name,
        input: structuredClone(input),
        outcome: "IN_FLIGHT"
      };
      this.requests.unshift(entry);
      // Retain full inputs; evict whole requests rather than truncate their content.
      while (
        this.requests.length > 12 ||
        (this.requests.length > 1 && JSON.stringify(this.requests).length > 2_000_000)
      )
        this.requests.pop();
      return entry as (typeof this.requests)[number];
    };
    const generate = provider.generateReply.bind(provider);
    provider.generateReply = async (input, options) => {
      const entry = record(input, "generateReply");
      try {
        const output = await generate(input, options);
        entry.outcome = "COMPLETED";
        entry.finalProvider = output.finalProvider;
        entry.model = output.model;
        entry.decision = inspectDecision(output);
        return output;
      } catch (error) {
        entry.outcome = "FAILED";
        entry.errorCode = inspectErrorCode(error);
        throw error;
      }
    };
    const stream = provider.streamReply?.bind(provider);
    if (stream)
      provider.streamReply = async function* (input, options) {
        const entry = record(input, "streamReply");
        try {
          for await (const event of stream(input, options)) {
            if (event.type === "completed") {
              entry.outcome = "COMPLETED";
              entry.finalProvider = event.output.finalProvider;
              entry.model = event.output.model;
              entry.decision = inspectDecision(event.output);
            }
            yield event;
          }
        } catch (error) {
          entry.outcome = "FAILED";
          entry.errorCode = inspectErrorCode(error);
          throw error;
        } finally {
          if (entry.outcome === "IN_FLIGHT") entry.outcome = "INTERRUPTED";
        }
      };
  }
  list() {
    return this.requests.map(({ input, ...entry }) => ({
      ...entry,
      characters: input.messages.reduce((n, m) => n + m.content.length, 0)
    }));
  }
  get(id: string) {
    const entry = this.requests.find((r) => r.id === id);
    if (!entry) return null;
    const parts = (entry.input.contextProjectionSpans ?? []).map((span) => ({
      ...span,
      authority: ["IDENTITY", "PERSONA", "RESPONSE_REQUIREMENTS"].includes(span.key)
        ? "AUTHORED"
        : ["MEMORY_EVIDENCE", "RECENT_CONVERSATION"].includes(span.key)
          ? "HISTORICAL_EVIDENCE"
          : "RUNTIME_CONTEXT",
      text:
        entry.input.messages[span.messageIndex]?.content.slice(
          span.offset,
          span.offset + span.characters
        ) ?? ""
    }));
    // Supplemental authored text and late perception already exist in the submitted messages.
    for (const [key, marker, end, authority] of [
      [
        "RESPONSE_REQUIREMENTS",
        "Response requirements (authored, for this surface):\n",
        "\nQuoted channel",
        "AUTHORED"
      ],
      [
        "VISUAL_OBSERVATION",
        "[PERCEPTION: image observation, not participant speech]\n",
        "",
        "RUNTIME_CONTEXT"
      ]
    ]) {
      entry.input.messages.forEach((message, messageIndex) => {
        if (parts.some((part) => part.key === key)) return;
        const index = message.content.indexOf(marker!);
        if (index < 0) return;
        const offset = index + marker!.length;
        const limit = end ? message.content.indexOf(end, offset) : -1;
        const text = message.content.slice(offset, limit < 0 ? undefined : limit);
        parts.push({
          key: key!,
          messageIndex,
          offset,
          characters: text.length,
          authority: authority!,
          text
        });
      });
    }
    return {
      ...entry,
      parts,
      boundary:
        "Exact ChatInput submitted to ChatModel; adapter defaults and wire serialization belong to Provider Registry."
    };
  }
}

/** Read-only observations of the actual response; these never authorize a turn. */
function inspectDecision(output: ChatOutput): Record<string, unknown> {
  const result: Record<string, unknown> = { finishReason: output.finishReason ?? "unknown" };
  try {
    const decoded = JSON.parse(output.message.content);
    for (const key of ["authorization", "disposition", "addressing"])
      if (typeof decoded[key] === "string") result[key] = decoded[key];
  } catch {
    /* Ordinary response bodies have no Character protocol decision. */
  }
  return result;
}
function inspectErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "PROVIDER_CALL_FAILED";
}
