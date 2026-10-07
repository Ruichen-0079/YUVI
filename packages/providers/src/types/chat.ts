import type {
  ProviderCallOptions,
  ProviderHealth,
  ProviderMetadata,
  TextMessage
} from "./common.js";

export type ChatInput = {
  messages: TextMessage[];
  /** Producer-declared serialization versions; evidence only, never context authority. */
  contextProjectionVersions?: readonly string[] | undefined;
  /** Producer-owned audit spans in submitted message text; never sent as model content. */
  contextProjectionSpans?:
    | readonly Readonly<{
        key: string;
        messageIndex: number;
        offset: number;
        characters: number;
        epistemicState?: string;
        transformed?: boolean;
      }>[]
    | undefined;
  model?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  stopSequences?: string[] | undefined;
  /**
   * @deprecated Method selection controls streaming. `generateReply()` is
   * always non-streaming and `streamReply()` is always streaming; this field
   * is retained only for input compatibility.
   */
  stream?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type ChatOutput = ProviderMetadata & {
  message: TextMessage;
  /** Reserved compatibility value; Runtime tool/function calling is unsupported. */
  finishReason?: "stop" | "length" | "tool_call" | "content_filter" | "unknown" | undefined;
};

export type ChatStreamingMode = "unsupported" | "native" | "compatible";

/** Streaming call controls; `streamReply()` is the authoritative stream API. */
export type ChatStreamOptions = ProviderCallOptions;

export type ChatStreamEvent =
  | {
      type: "text-delta";
      text: string;
      sourceAttemptId?: string | undefined;
    }
  | {
      type: "completed";
      output: ChatOutput;
    };

export interface ChatProvider {
  readonly name: string;
  readonly streamingMode?: ChatStreamingMode | undefined;
  healthCheck(): Promise<ProviderHealth>;
  generateReply(input: ChatInput, options?: ProviderCallOptions): Promise<ChatOutput>;
  streamReply?(
    input: ChatInput,
    options?: ChatStreamOptions | undefined
  ): AsyncIterable<ChatStreamEvent>;
}
