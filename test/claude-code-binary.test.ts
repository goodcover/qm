import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mock, test, type TestContext } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Message } from "@earendil-works/pi-ai";
import {
  CLAUDE_CODE_TEST_SYSTEM,
  claudeCodeSession,
  lastAssistant,
  lookupTool,
} from "./support/claude-code-session.ts";
import { processAlive } from "./support/fake-claude-code.ts";
import { anthropicMessage } from "./support/gateway-stream.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "sk-ant-oat01-binary-contract-test";

type Block = Record<string, unknown> & { type: string };
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

const RATE_LIMIT_HEADERS = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3600),
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-5h-utilization": "0.12",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
};

function systemText(call: Captured): string {
  return (call.body.system ?? []).map((block) => block.text).join("\n");
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

async function mockMessagesApi(t: TestContext, hang = false) {
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
      res.writeHead(200, { "content-type": "text/event-stream", ...RATE_LIMIT_HEADERS });
      if (!isTurn(call)) return res.end(reply(model, { type: "text", text: "side request" }, "end_turn"));
      const lastUser = conversation(call).findLast((message) => message.role === "user")!;
      const result = lastUser.content.find((block) => block.type === "tool_result");
      if (!result)
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

test("the bundled Claude Code binary serves QM tool turns with only QM's tools and a faithful history", async (t) => {
  const api = await mockMessagesApi(t);
  const sdk = await pointClaudeCodeAt(t, api.url);
  const executed: string[] = [];
  const description = `${"D".repeat(6000)} end of description`;
  const tools = [lookupTool(executed), { ...lookupTool([]), name: "long_doc", description }];
  const first = await claudeCodeSession({ anthropic: TOKEN }, tools);
  await first.session.prompt("Compare alpha");
  await first.close();
  const live = api.captured.filter(isTurn);
  t.diagnostic(`paths: ${api.captured.map((call) => call.path).join(", ")}`);
  t.diagnostic(`user-agent: ${String(live[0]?.headers["user-agent"])}`);
  t.diagnostic(
    `system blocks: ${JSON.stringify((live[0]?.body.system ?? []).map((block) => block.text.slice(0, 80)))}`,
  );
  t.diagnostic(`claude code reminder: ${JSON.stringify(environmentReminder(live[0]!))}`);
  assert.equal(lastAssistant(first.session).stopReason, "stop", JSON.stringify(lastAssistant(first.session)));
  assert.deepEqual(executed, ["alpha"]);
  assert.deepEqual(lastAssistant(first.session).content, [{ type: "text", text: "done after record alpha" }]);
  assert.equal(live.length, 2, "one tool step and one closing step");
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
  assert.ok(
    sdk.children.every((child) => !processAlive(child)),
    "every Claude Code process exited",
  );
  assert.ok(sdk.spawned.every((options) => !existsSync(String(options.env?.CLAUDE_CONFIG_DIR))));

  api.captured.length = 0;
  const second = await claudeCodeSession({ anthropic: TOKEN }, tools, [...first.session.messages] as Message[]);
  await second.session.prompt("And again?");
  await second.close();
  const resumed = api.captured.find(isTurn)!;
  const before = conversation(live[1]!);
  const after = conversation(resumed);
  assert.deepEqual(
    after.slice(0, before.length),
    before,
    "the imported history is the conversation Claude Code sent live",
  );
  assert.deepEqual(
    after.slice(before.length).map((message) => [message.role, message.content.map((block) => block.text)]),
    [
      ["assistant", ["done after record alpha"]],
      ["user", ["And again?"]],
    ],
  );
  assert.equal(
    environmentReminder(resumed),
    environmentReminder(live[0]!),
    "Claude Code's own reminder is identical across queries",
  );
});

test("aborting a turn kills the real Claude Code process mid-request", async (t) => {
  const api = await mockMessagesApi(t, true);
  const sdk = await pointClaudeCodeAt(t, api.url);
  const { session, close } = await claudeCodeSession({ anthropic: TOKEN }, [lookupTool([])]);
  const prompting = session.prompt("this request never answers");
  for (let i = 0; i < 400 && !api.captured.some((call) => call.path === "/v1/messages"); i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const child = sdk.children[0];
  assert.ok(processAlive(child), "Claude Code is running and waiting on the API");
  await session.abort();
  await prompting.catch(() => undefined);
  await close();
  for (let i = 0; i < 400 && processAlive(child); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(!processAlive(child));
  assert.ok(!existsSync(String(sdk.spawned[0]!.env?.CLAUDE_CONFIG_DIR)));
  assert.equal(lastAssistant(session).stopReason, "aborted");
});

test("text a person types reaches the real binary verbatim: no slash commands, no @file reads, no planted project files", async (t) => {
  const api = await mockMessagesApi(t);
  await pointClaudeCodeAt(t, api.url);
  const work = join(tmpdir(), "qm-claude-code-cwd");
  mkdirSync(join(work, ".claude"), { recursive: true });
  writeFileSync(join(work, "CLAUDE.md"), "PLANTED-CLAUDE-MD");
  writeFileSync(
    join(work, ".claude", "settings.json"),
    JSON.stringify({ env: { PLANTED_SETTING: "1" }, model: "claude-haiku-4-5" }),
  );
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
