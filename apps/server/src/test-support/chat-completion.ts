/** Deterministic network dependency fixture. Product Gate/body assembly stays active. */
export function chatCompletionFixture(
  request: {
    stream?: boolean;
    model?: string;
    messages?: Array<{ role: string; content: string }>;
  },
  reply: {
    content: string;
    model?: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }
): Response {
  const control =
    !request.stream && request.messages?.[0]?.content.includes("Decide control flow only");
  const content = control ? JSON.stringify({ disposition: "RESPOND" }) : reply.content;
  const model = reply.model ?? request.model;
  if (!request.stream)
    return new Response(
      JSON.stringify({
        model,
        choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: reply.usage
      }),
      { headers: { "content-type": "application/json" } }
    );
  return new Response(
    [
      `data: ${JSON.stringify({ model, choices: [{ delta: { content }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ model, choices: [{ delta: {}, finish_reason: "stop" }], usage: reply.usage })}`,
      "data: [DONE]"
    ].join("\n\n") + "\n\n",
    { headers: { "content-type": "text/event-stream" } }
  );
}
