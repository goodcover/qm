import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const script = process.argv[2];
let mcp: { url: string; headers: Record<string, string> } | undefined;
const never = new Promise<never>(() => undefined);

acp
  .agent({ name: "fake-antigravity" })
  .onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest("session/new", ({ params }) => {
    const server = params.mcpServers[0] as { url: string; headers: Array<{ name: string; value: string }> };
    mcp = { url: server.url, headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) };
    return { sessionId: "fake-session" };
  })
  .onRequest("session/set_config_option", () => ({ configOptions: [] }))
  .onRequest("session/prompt", async ({ params, client }) => {
    const update = (value: Record<string, unknown>) =>
      client.notify("session/update", { sessionId: params.sessionId, update: value as acp.SessionUpdate });
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
    const name = script === "foreign" ? "read_file" : "mcp_qm_lookup";
    if (script === "hang") return never;
    if (script === "refusal" || script === "cancelled") return { stopReason: script };
    if (script === "quota") throw acp.RequestError.internalError({ details: "daily quota reached" });
    if (script === "die") process.exit(7);
    await update({ sessionUpdate: "tool_call", toolCallId: "t1", title: `Run ${name}`, name });
    if (script === "foreign") return never;
    const answer = await client.request("session/request_permission", {
      sessionId: params.sessionId,
      toolCall: { toolCallId: "t1", name } as acp.ToolCallUpdate,
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    if (answer.outcome.outcome !== "selected" || answer.outcome.optionId !== "allow") throw new Error("denied");
    const tools = new Client({ name: "fake-antigravity", version: "1.0.0" });
    await tools.connect(
      new StreamableHTTPClientTransport(new URL(mcp!.url), { requestInit: { headers: mcp!.headers } }),
    );
    const result = await tools.callTool({ name: "lookup", arguments: { key: "kiwi" } });
    const [block] = result.content as Array<{ text: string }>;
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ` saw ${block!.text}` } });
    return { stopReason: "end_turn", usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 } };
  })
  .connect(
    acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
  );
