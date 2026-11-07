import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mock, test, type TestContext } from "node:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Message } from "@earendil-works/pi-ai";
import type { ChildProcess } from "node:child_process";
import {
  CLAUDE_CODE_TEST_SYSTEM,
  claudeCodeSession,
  lastAssistant,
  lookupTool,
} from "./support/claude-code-session.ts";
import { processAlive } from "./support/fake-claude-code.ts";

const TOKEN = "sk-ant-oat01-binary-contract-test";

interface Captured {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function reply(model: string, block: Record<string, unknown>, stop: string): string {
  const start =
    block.type === "tool_use"
      ? { type: "content_block_start", index: 0, content_block: { ...block, input: {} } }
      : { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
  const delta =
    block.type === "tool_use"
      ? {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        }
      : { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } };
  return sse([
    {
      type: "message_start",
      message: {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 21, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
    start,
    delta,
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 6 } },
    { type: "message_stop" },
  ]);
}

const RATE_LIMIT_HEADERS = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3600),
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-5h-utilization": "0.12",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
};

async function mockMessagesApi(t: TestContext, hang = false) {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      captured.push({ path: req.url ?? "", headers: req.headers, body });
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not mocked" } }));
        return;
      }
      if (hang) return;
      const model = String(body.model);
      const messages = JSON.stringify(body.messages ?? []);
      const isTurn = JSON.stringify(body.system ?? "").includes(CLAUDE_CODE_TEST_SYSTEM);
      res.writeHead(200, { "content-type": "text/event-stream", ...RATE_LIMIT_HEADERS });
      if (!isTurn) return res.end(reply(model, { type: "text", text: "side request" }, "end_turn"));
      const lastUser = JSON.stringify((body.messages as Array<{ role: string }>).findLast((m) => m.role === "user"));
      if (!lastUser.includes("tool_result"))
        return res.end(
          reply(
            model,
            { type: "tool_use", id: `toolu_${captured.length}`, name: "mcp__qm__lookup", input: { key: "alpha" } },
            "tool_use",
          ),
        );
      res.end(
        reply(
          model,
          { type: "text", text: `done after ${messages.includes("record alpha") ? "record alpha" : "nothing"}` },
          "end_turn",
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { captured, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function pointClaudeCodeAt(t: TestContext, url: string) {
  const real = await import("@anthropic-ai/claude-agent-sdk");
  const spawned: Options[] = [];
  const children: ChildProcess[] = [];
  const mocked = mock.module("@anthropic-ai/claude-agent-sdk", {
    namedExports: {
      ...real,
      query: ({ prompt, options }: { prompt: AsyncIterable<never>; options: Options }) => {
        spawned.push(options);
        const spawn = options.spawnClaudeCodeProcess!;
        return real.query({
          prompt,
          options: {
            ...options,
            env: { ...options.env, ANTHROPIC_BASE_URL: url },
            spawnClaudeCodeProcess: (spawnOptions) => {
              const child = spawn(spawnOptions);
              children.push(child as unknown as ChildProcess);
              return child;
            },
          },
        });
      },
    },
  });
  t.after(() => mocked.restore());
  return { spawned, children };
}

test("the bundled Claude Code binary serves a QM tool turn with only QM's tools on the wire", async (t) => {
  const api = await mockMessagesApi(t);
  const sdk = await pointClaudeCodeAt(t, api.url);
  const executed: string[] = [];
  const first = await claudeCodeSession({ anthropic: TOKEN }, [lookupTool(executed)]);
  const limits: string[] = [];
  const logError = console.error.bind(console);
  t.mock.method(console, "error", (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[claude-code] subscription limit")) limits.push(line);
    logError(...args);
  });
  await first.session.prompt("Compare alpha");
  await first.close();
  const turnCalls = api.captured.filter((call) =>
    JSON.stringify(call.body.system ?? "").includes(CLAUDE_CODE_TEST_SYSTEM),
  );
  t.diagnostic(`requests: ${api.captured.map((call) => call.path).join(", ")}`);
  t.diagnostic(`user-agent: ${String(turnCalls[0]?.headers["user-agent"])}`);
  const systemBlocks = (turnCalls[0]?.body.system ?? []) as Array<{ text: string }>;
  t.diagnostic(`system blocks: ${JSON.stringify(systemBlocks.map((b) => b.text.slice(0, 80)))}`);
  assert.equal(lastAssistant(first.session).stopReason, "stop", JSON.stringify(lastAssistant(first.session)));
  assert.deepEqual(executed, ["alpha"]);
  assert.match(JSON.stringify(lastAssistant(first.session).content), /done after record alpha/);
  assert.equal(turnCalls.length, 2, "one tool step and one closing step");
  for (const call of turnCalls) {
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers["x-api-key"], undefined);
    assert.match(String(call.headers["user-agent"]), /sdk-ts/);
    assert.match(String(call.headers["user-agent"]), /qm\/claude-code-provider/);
    assert.deepEqual(
      (call.body.tools as Array<{ name: string }>).map((tool) => tool.name),
      ["mcp__qm__lookup"],
      "no Claude Code built-in tool is offered to the model",
    );
    assert.ok(JSON.stringify(call.body.system).includes(CLAUDE_CODE_TEST_SYSTEM));
  }
  assert.match(JSON.stringify(turnCalls[1]!.body.messages), /tool_result.*record alpha/);
  const limit = JSON.parse(limits.at(-1)!.slice("[claude-code] subscription limit ".length)) as Record<string, unknown>;
  assert.equal(limit.status, "allowed");
  assert.equal(limit.overageDisabledReason, "org_level_disabled");
  assert.notEqual(limit.isUsingOverage, true);
  assert.ok(
    sdk.children.every((child) => !processAlive(child)),
    "every Claude Code process exited",
  );
  assert.ok(sdk.spawned.every((options) => !existsSync(String(options.env?.CLAUDE_CONFIG_DIR))));

  api.captured.length = 0;
  const second = await claudeCodeSession({ anthropic: TOKEN }, [lookupTool(executed)], [
    ...first.session.messages,
  ] as Message[]);
  await second.session.prompt("And again?");
  await second.close();
  const resumed = api.captured.find((call) => JSON.stringify(call.body.system ?? "").includes(CLAUDE_CODE_TEST_SYSTEM));
  const messages = resumed?.body.messages as Array<{ role: string; content: unknown }>;
  t.diagnostic(`resumed request roles: ${messages.map((m) => m.role).join(",")}`);
  const flat = JSON.stringify(messages);
  assert.ok(
    flat.indexOf("Compare alpha") < flat.indexOf("mcp__qm__lookup"),
    "prior prompt precedes the prior tool call",
  );
  assert.ok(flat.indexOf("record alpha") < flat.indexOf("And again?"), "prior tool result precedes the new prompt");
  assert.match(flat, /done after record alpha/);
});

test("aborting a turn kills the real Claude Code process mid-request", async (t) => {
  const api = await mockMessagesApi(t, true);
  const sdk = await pointClaudeCodeAt(t, api.url);
  const { session, close } = await claudeCodeSession({ anthropic: TOKEN }, [lookupTool([])]);
  const prompting = session.prompt("this request never answers");
  for (let i = 0; i < 400 && !api.captured.some((call) => call.path.startsWith("/v1/messages")); i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const child = sdk.children[0];
  assert.ok(processAlive(child), "Claude Code is running and waiting on the API");
  await session.abort();
  await prompting.catch(() => undefined);
  await close();
  for (let i = 0; i < 200 && processAlive(child); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(!processAlive(child));
  assert.ok(!existsSync(String(sdk.spawned[0]!.env?.CLAUDE_CONFIG_DIR)));
  api.server.closeAllConnections();
});
