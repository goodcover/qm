import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test, type TestContext } from "node:test";
import { Type } from "typebox";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Message } from "@earendil-works/pi-ai";
import { sleep } from "../src/util/async.ts";
import {
  CLAUDE_CODE_TEST_SYSTEM,
  claudeCodeSession,
  lastAssistant,
  lookupTool,
} from "./support/claude-code-session.ts";
import { lastUser, type Block } from "./support/fake-claude-code.ts";
import { anthropicMessage } from "./support/gateway-stream.ts";

const TOKEN = "sk-ant-oat01-binary-contract-test";

type WireMessage = { role: string; content: string | Block[] };
interface Captured {
  path: string;
  headers: IncomingHttpHeaders;
  body: {
    model?: string;
    system?: Array<{ text: string }>;
    messages?: WireMessage[];
    tools?: Array<{ name: string; description: string }>;
  };
}

function reply(model: string, block: Block, stop: string): string {
  return anthropicMessage(model, [block], stop, {
    input_tokens: 21,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
}

const OVERAGE_IN_USE = {
  "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3600),
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-overage-status": "allowed",
  "anthropic-ratelimit-unified-overage-in-use": "true",
};

function systemText(call: Captured): string {
  return (call.body.system ?? []).map((block) => block.text).join("\n");
}

function withoutCacheMarks(call: Captured): WireMessage[] {
  return (call.body.messages ?? []).map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map(({ cache_control: _cache, ...block }) => block as Block),
  }));
}

function conversation(call: Captured): Array<{ role: string; content: Block[] }> {
  return (call.body.messages ?? [])
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content).map(
        ({ cache_control: _cache, ...block }) => block as Block,
      ),
    }));
}

function environmentReminder(call: Captured): string {
  const system = (call.body.messages ?? []).filter((message) => message.role === "system");
  return system
    .flatMap((message) =>
      typeof message.content === "string" ? [message.content] : message.content.map((b) => String(b.text)),
    )
    .join("\n");
}

function isTurn(call: Captured): boolean {
  return systemText(call).includes(CLAUDE_CODE_TEST_SYSTEM);
}

function running(options: Options): boolean {
  const session = String(options.sessionId ?? options.resume);
  return readdirSync("/proc").some((pid) => {
    try {
      return /^\d+$/.test(pid) && readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(session);
    } catch {
      return false;
    }
  });
}

async function mockMessagesApi(
  t: TestContext,
  {
    hang = false,
    headers = {},
    alwaysCallTool = false,
    other,
  }: {
    hang?: boolean;
    headers?: Record<string, string>;
    alwaysCallTool?: boolean;
    other?: (call: Captured) => string;
  } = {},
) {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const call: Captured = {
        path: new URL(req.url ?? "/", "http://mock").pathname,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : {},
      };
      captured.push(call);
      if (call.path !== "/v1/messages") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not mocked" } }));
        return;
      }
      if (hang) return;
      const model = String(call.body.model);
      res.writeHead(200, { "content-type": "text/event-stream", ...headers });
      if (!isTurn(call))
        return res.end(other?.(call) ?? reply(model, { type: "text", text: "side request" }, "end_turn"));
      const result = lastUser({ messages: conversation(call) }).find((block) => block.type === "tool_result");
      if (!result || alwaysCallTool)
        return res.end(
          reply(
            model,
            { type: "tool_use", id: `toolu_${captured.length}`, name: "mcp__qm__lookup", input: { key: "alpha" } },
            "tool_use",
          ),
        );
      const text = (result.content as Block[]).map((block) => String(block.text)).join("");
      res.end(reply(model, { type: "text", text: `done after ${text}` }, "end_turn"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { captured, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function pointClaudeCodeAt(t: TestContext, url: string) {
  const real = await import("@anthropic-ai/claude-agent-sdk");
  const spawned: Options[] = [];
  const mocked = mock.module("@anthropic-ai/claude-agent-sdk", {
    namedExports: {
      ...real,
      query: ({ prompt, options }: { prompt: AsyncIterable<never>; options: Options }) => {
        spawned.push(options);
        return real.query({ prompt, options: { ...options, env: { ...options.env, ANTHROPIC_BASE_URL: url } } });
      },
    },
  });
  t.after(() => mocked.restore());
  return spawned;
}

function cleanedUp(spawned: readonly Options[]): boolean {
  return spawned.every((options) => !running(options) && !existsSync(String(options.env?.CLAUDE_CONFIG_DIR)));
}

test("the bundled Claude Code binary serves QM tool turns with only QM's tools and a faithful history", async (t) => {
  const api = await mockMessagesApi(t);
  const spawned = await pointClaudeCodeAt(t, api.url);
  const executed: string[] = [];
  const description = `${"D".repeat(6000)} end of description`;
  const tools = [lookupTool(executed), { ...lookupTool([]), name: "long_doc", description }];
  const first = await claudeCodeSession({ anthropic: TOKEN }, tools);
  await first.session.prompt("Compare alpha");
  await first.close();
  const live = api.captured.filter(isTurn);
  assert.equal(lastAssistant(first.session).stopReason, "stop", JSON.stringify(lastAssistant(first.session)));
  assert.deepEqual(executed, ["alpha"]);
  assert.deepEqual(lastAssistant(first.session).content, [{ type: "text", text: "done after record alpha" }]);
  assert.equal(live.length, 2, "one tool step and one closing step");
  assert.equal(api.captured.length, live.length, "Claude Code made no request of its own");
  for (const call of live) {
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers["x-api-key"], undefined);
    assert.ok(String(call.headers["user-agent"]).includes("sdk-ts"));
    assert.ok(String(call.headers["user-agent"]).includes("client-app/qm/claude-code-provider"));
    const offered = new Map(call.body.tools?.map((tool) => [tool.name, tool.description]));
    assert.deepEqual(
      [...offered.keys()].sort(),
      ["mcp__qm__long_doc", "mcp__qm__lookup"],
      "no Claude Code built-in tool is offered to the model",
    );
    assert.equal(offered.get("mcp__qm__long_doc"), description, "a long tool description arrives whole");
    assert.ok(!environmentReminder(call).includes("<total_tokens>"), "no per-step token countdown");
  }
  assert.ok(cleanedUp(spawned), "every Claude Code process exited and its directory is gone");

  api.captured.length = 0;
  const second = await claudeCodeSession({ anthropic: TOKEN }, tools, [...first.session.messages] as Message[]);
  await second.session.prompt("And again?");
  await second.close();
  const resumed = api.captured.find(isTurn)!;
  const before = withoutCacheMarks(live[1]!);
  const after = withoutCacheMarks(resumed);
  assert.deepEqual(
    after.slice(0, before.length),
    before,
    "the next turn's request starts with the previous request byte for byte, so its prompt cache is read",
  );
  assert.deepEqual(
    conversation(resumed)
      .slice(conversation(live[1]!).length)
      .map((message) => [message.role, message.content.map((block) => block.text)]),
    [
      ["assistant", ["done after record alpha"]],
      ["user", ["And again?"]],
    ],
  );
  assert.ok(cleanedUp(spawned));
});

test("aborting a turn kills the real Claude Code process mid-request", async (t) => {
  const api = await mockMessagesApi(t, { hang: true });
  const spawned = await pointClaudeCodeAt(t, api.url);
  const { session, close } = await claudeCodeSession({ anthropic: TOKEN }, [lookupTool([])]);
  const prompting = session.prompt("this request never answers");
  for (let i = 0; i < 400 && !api.captured.some((call) => call.path === "/v1/messages"); i++) await sleep(25);
  assert.ok(running(spawned[0]!), "Claude Code is running and waiting on the API");
  await session.abort();
  await prompting.catch(() => undefined);
  await close();
  assert.ok(cleanedUp(spawned), "the real Claude Code process is gone and its directory removed once QM closes");
  assert.equal(lastAssistant(session).stopReason, "aborted");
});

test("text a person types reaches the real binary verbatim: no slash commands, no @file reads, no planted project files", async (t) => {
  const api = await mockMessagesApi(t);
  await pointClaudeCodeAt(t, api.url);
  const work = join(tmpdir(), "qm-claude-code-cwd");
  mkdirSync(join(work, ".claude"), { recursive: true });
  writeFileSync(join(work, "CLAUDE.md"), "PLANTED-CLAUDE-MD");
  writeFileSync(join(work, ".claude", "settings.json"), JSON.stringify({ model: "claude-haiku-4-5" }));
  writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { planted: { command: "/bin/false" } } }));
  t.after(() => {
    rmSync(join(work, "CLAUDE.md"), { force: true });
    rmSync(join(work, ".mcp.json"), { force: true });
    rmSync(join(work, ".claude"), { recursive: true, force: true });
  });
  const { session, close } = await claudeCodeSession({ anthropic: TOKEN }, [lookupTool([])]);
  const typed = "/model claude-haiku-4-5 and also @/etc/hostname";
  await session.prompt(typed);
  await close();
  const call = api.captured.find(isTurn)!;
  assert.equal(call.body.model, "claude-sonnet-5", "the slash command did not switch models");
  assert.deepEqual(
    conversation(call)[0]!.content.map((block) => block.text),
    [typed],
    "the person's text arrived as written",
  );
  const wire = JSON.stringify(call.body);
  assert.ok(!wire.includes("Called the Read tool"), "no file mentioned with @ was read from the host");
  assert.ok(!wire.includes("PLANTED-CLAUDE-MD"), "a CLAUDE.md in the working directory was not loaded");
  assert.deepEqual(
    call.body.tools?.map((tool) => tool.name),
    ["mcp__qm__lookup"],
    "a planted .mcp.json added no tools",
  );
});

test("Claude reporting extra usage in use stops the turn through the real binary", async (t) => {
  const api = await mockMessagesApi(t, { headers: OVERAGE_IN_USE, alwaysCallTool: true });
  const spawned = await pointClaudeCodeAt(t, api.url);
  const { session, close } = await claudeCodeSession({ anthropic: TOKEN }, [lookupTool([])]);
  await session.prompt("Compare alpha").catch(() => undefined);
  await close();
  const failed = lastAssistant(session);
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.providerError?.code, "overage_in_use", failed.errorMessage);
  assert.ok(
    api.captured.filter(isTurn).length <= 2,
    `the query stops at the first overage report; only a request already in flight can follow it (saw ${api.captured.filter(isTurn).length})`,
  );
  assert.ok(cleanedUp(spawned));
});

test("another Claude Code session on the host cannot message a QM query", async (t) => {
  const marker = "PEER-MESSAGE-4417";
  let socket = "";
  let senderSteps = 0;
  const api = await mockMessagesApi(t, {
    other: (call) => {
      const model = String(call.body.model);
      senderSteps += 1;
      if (senderSteps === 1)
        return reply(
          model,
          {
            type: "tool_use",
            id: "toolu_find",
            name: "ToolSearch",
            input: { query: "select:SendMessage", max_results: 1 },
          },
          "tool_use",
        );
      if (senderSteps === 2)
        return reply(
          model,
          { type: "tool_use", id: "toolu_send", name: "SendMessage", input: { to: `uds:${socket}`, message: marker } },
          "tool_use",
        );
      return reply(model, { type: "text", text: "sent" }, "end_turn");
    },
  });
  const spawned = await pointClaudeCodeAt(t, api.url);
  const senderHome = mkdtempSync(join(tmpdir(), "qm-peer-sender-"));
  t.after(() => rmSync(senderHome, { recursive: true, force: true }));
  const sendFromPeer = async () => {
    const qmDir = String(spawned[0]!.env?.CLAUDE_CONFIG_DIR);
    socket = join(
      qmDir,
      "cc-socks",
      readdirSync(join(qmDir, "cc-socks")).find((name) => name.endsWith(".sock"))!,
    );
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const env = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: senderHome,
      CLAUDE_CONFIG_DIR: senderHome,
      CLAUDE_CODE_TMPDIR: senderHome,
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    const options = { cwd: senderHome, env, settingSources: [], allowedTools: ["ToolSearch", "SendMessage"] };
    for await (const _message of query({ prompt: "send it", options: options as Options }));
  };
  const parkedTool = {
    name: "lookup",
    label: "Lookup",
    description: "Look up one record by key.",
    parameters: Type.Object({ key: Type.String() }),
    async execute() {
      await sendFromPeer();
      return { content: [{ type: "text" as const, text: "record alpha" }], details: {} };
    },
  };
  const { session, close } = await claudeCodeSession({ anthropic: TOKEN }, [parkedTool]);
  await session.prompt("Compare alpha");
  await close();
  const delivered = api.captured.find((call) => JSON.stringify(call.body.messages).includes("toolu_send"));
  assert.ok(
    delivered && JSON.stringify(delivered.body.messages).includes('\\"success\\":true'),
    "the peer's send succeeded",
  );
  assert.ok(
    api.captured.filter(isTurn).every((call) => !JSON.stringify(call.body).includes(marker)),
    "the peer's message never reached QM's model request",
  );
  assert.ok(cleanedUp([spawned[0]!]));
});
