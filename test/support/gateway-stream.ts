import type { TestContext } from "node:test";

export function anthropicMessage(
  model: string,
  blocks: Array<Record<string, unknown> & { type: string }>,
  stop: string,
  usage: Record<string, number> = { input_tokens: 1, output_tokens: 0 },
): string {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg_context",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    },
  ];
  blocks.forEach((block, index) => {
    const toolUse = block.type === "tool_use";
    events.push({
      type: "content_block_start",
      index,
      content_block: toolUse ? { ...block, input: {} } : { type: "text", text: "" },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta: toolUse
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text: block.text },
    });
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  events.push({ type: "message_stop" });
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

export function anthropicStream(text: string): string {
  return anthropicMessage("router/haiku", [{ type: "text", text }], "end_turn");
}

export function recordRequests(t: TestContext, reply = "ok"): Array<{ url: string; headers: Headers; body: string }> {
  const requests: Array<{ url: string; headers: Headers; body: string }> = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    return new Response(anthropicStream(reply), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return requests;
}

export const contextHeaders = (headers: Headers) =>
  Object.fromEntries([...headers].filter(([name]) => name.startsWith("x-qm-")));
