import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import { Type } from "typebox";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { resolveModel } from "../src/model/pi-models.ts";
import { providerTurnError } from "../src/model/provider-error.ts";
import { setProviderBaseUrls } from "../src/model/provider-endpoints.ts";
import { zeroUsage } from "../src/model/model-runtime.ts";
import { answered, installFakeClaudeCode, lastUser, type Block, type FakeReply } from "./support/fake-claude-code.ts";
import {
  CLAUDE_CODE_TEST_MODEL as MODEL_ID,
  claudeCodeSession as piSession,
  lastAssistant,
  lookupTool,
} from "./support/claude-code-session.ts";
import { sleep } from "../src/util/async.ts";
import { anthropicMessage } from "./support/gateway-stream.ts";

type ThinkingLevel = Parameters<AgentSession["setThinkingLevel"]>[0];

function wireThinking(thinking: unknown): unknown {
  const { budgetTokens, ...rest } = (thinking ?? {}) as { budgetTokens?: number };
  return budgetTokens ? { ...rest, budget_tokens: budgetTokens } : rest;
}

const TOKEN = "sk-ant-oat01-claude-code-test";

function texts(blocks: Block[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === "text") return [String(block.text)];
    if (block.type === "tool_result") return texts(block.content as Block[]);
    return [];
  });
}

function assistantFrom(model: string, content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}) {
  const resolved = resolveModel(model);
  return {
    role: "assistant",
    content,
    api: resolved?.api ?? "openai-responses",
    provider: resolved?.provider ?? "openai",
    model: resolved?.id ?? model,
    usage: zeroUsage() as Usage,
    stopReason: "toolUse",
    timestamp: 1,
    ...extra,
  } as AssistantMessage;
}

test("a multi-tool turn runs QM tools only through Pi and pairs every result with its tool_use id", async (t) => {
  const executed: string[] = [];
  const fake = await installFakeClaudeCode((request) =>
    answered(request)
      ? { text: "done", usage: { input: 30, output: 7, cacheRead: 20 } }
      : {
          thinking: { text: "need two records", signature: "sig-1" },
          text: "Looking both up.",
          tools: [
            { id: "toolu_a", name: "mcp__qm__lookup", input: { key: "alpha" } },
            { id: "toolu_b", name: "mcp__qm__lookup", input: { key: "beta" } },
          ],
          callOrder: "reverse",
          usage: { input: 12, output: 9 },
        },
  );
  t.after(fake.restore);
  const ambient = {
    ANTHROPIC_API_KEY: "sk-ant-api03-ambient",
    ANTHROPIC_AUTH_TOKEN: "ambient-auth",
    ANTHROPIC_BASE_URL: "http://gateway.invalid",
    CLAUDE_CODE_MESSAGING_TOKEN: "parent-session-token",
    DATABASE_URL: "postgres://secret@db.invalid/qm",
  };
  const saved = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]));
  Object.assign(process.env, ambient);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { session, close } = await piSession({ anthropic: TOKEN }, [lookupTool(executed)]);
  const streamed: string[] = [];
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      streamed.push(event.assistantMessageEvent.delta);
  });
  await session.prompt("Compare alpha and beta");
  await close();
  const call = fake.calls[0]!;

  assert.deepEqual(executed.sort(), ["alpha", "beta"], "each tool ran exactly once, in QM's process");
  assert.deepEqual(
    Object.fromEntries(call.mcpCalls.map((c) => [c.id, c.result])),
    {
      toolu_a: { content: [{ type: "text", text: "record alpha" }] },
      toolu_b: { content: [{ type: "text", text: "record beta" }] },
    },
    "results pair by tool_use id even when Claude Code calls them in reverse order",
  );
  const toolStep = session.messages.find(
    (message) => message.role === "assistant" && message.stopReason === "toolUse",
  ) as AssistantMessage;
  assert.deepEqual(
    toolStep.content.map((block) => block.type),
    ["thinking", "text", "toolCall", "toolCall"],
  );
  assert.equal((toolStep.content[0] as { thinkingSignature?: string }).thinkingSignature, "sig-1");
  assert.deepEqual((toolStep.content[2] as { arguments: unknown }).arguments, { key: "alpha" });
  assert.equal(toolStep.usage.input, 12);
  assert.equal(lastAssistant(session).usage.cacheRead, 20);
  assert.ok(lastAssistant(session).usage.cost.total > 0);
  assert.equal(streamed.join(""), "Looking both up.done", "text reaches QM's surfaces as it streams");

  assert.equal(fake.calls.length, 1, "one Claude Code query served the whole turn");
  assert.equal(call.options.systemPrompt, session.systemPrompt, "QM's system prompt is the system prompt, verbatim");
  assert.deepEqual(
    call.listedTools.map((tool) => [tool.name, tool.description, tool.inputSchema]),
    [["lookup", lookupTool([]).description, JSON.parse(JSON.stringify(lookupTool([]).parameters))]],
    "tool descriptions and schemas reach Claude Code unchanged",
  );
  const env = call.options.env as Record<string, string>;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(env.HOME, env.CLAUDE_CONFIG_DIR);
  assert.notEqual(env.HOME, homedir());
  for (const [key, value] of Object.entries(ambient)) {
    assert.equal(env[key], undefined, `${key} is not inherited`);
    assert.ok(!Object.values(env).includes(value));
  }
});

test("metered keys, an operator Anthropic base URL and gateway-served models stay on Pi's direct path", async (t) => {
  const fake = await installFakeClaudeCode(() => ({ text: "from Claude Code" }));
  t.after(fake.restore);
  const direct: Array<{ host: string; apiKey: string | null; authorization: string | null }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    direct.push({
      host: new URL(String(input instanceof Request ? input.url : input)).host,
      apiKey: headers.get("x-api-key"),
      authorization: headers.get("authorization"),
    });
    return new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "direct" } }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    );
  });
  const prompt = async (keys: Parameters<typeof piSession>[0], options?: Parameters<typeof piSession>[3]) => {
    const run = await piSession(keys, [], [], options);
    await run.session.prompt("hi").catch(() => undefined);
    await run.close();
    return lastAssistant(run.session);
  };

  await prompt({ anthropic: "sk-ant-api03-metered" });
  assert.equal(direct.at(-1)?.apiKey, "sk-ant-api03-metered", "a metered key goes to the Anthropic API");

  setProviderBaseUrls({ anthropic: "https://egress.invalid" });
  t.after(() => setProviderBaseUrls({}));
  await prompt({ anthropic: TOKEN });
  assert.equal(direct.at(-1)?.host, "egress.invalid", "an operator base URL keeps Anthropic traffic on that URL");
  setProviderBaseUrls({});

  const gateway = {
    url: "http://gateway.invalid/v1",
    apiKey: "gk",
    apiKeyHeader: "api-key",
    models: { [MODEL_ID]: `anthropic/${MODEL_ID}` },
  };
  await prompt({ anthropic: TOKEN }, { gateway });
  assert.equal(direct.at(-1)?.host, "gateway.invalid", "the gateway serves the models it carries");
  assert.equal(fake.calls.length, 0, "Claude Code never started");

  const unmapped = await prompt({ anthropic: TOKEN }, { gateway: { ...gateway, models: {} } });
  assert.equal(unmapped.stopReason, "stop", unmapped.errorMessage);
  assert.equal(fake.calls.length, 1, "a model the gateway does not carry runs on the subscription through Claude Code");
  assert.deepEqual(
    direct.filter((call) => call.host === "api.anthropic.com").map((call) => call.apiKey),
    ["sk-ant-api03-metered"],
    "only the metered key reached the Anthropic API directly",
  );
});

test("Claude Code tool calls QM did not serve never reach QM", async (t) => {
  const executed: string[] = [];
  const fake = await installFakeClaudeCode((request) =>
    answered(request)
      ? { text: "finished" }
      : {
          tools: [
            { id: "toolu_bash", name: "Bash", input: { command: "cat ~/.ssh/id_rsa" } },
            { id: "toolu_ok", name: "mcp__qm__lookup", input: { key: "gamma" } },
          ],
        },
  );
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, [lookupTool(executed)]);
  await session.prompt("go");
  await close();
  assert.deepEqual(executed, ["gamma"]);
  const toolNames = session.messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : []))
      : [],
  );
  assert.deepEqual(toolNames, ["lookup"], "Pi only ever saw the served tool");
});

test("a mismatched tool list, an API key source, unconfigured settings or an unconfigured hook fails the turn closed and is not retried", async () => {
  const cases = [
    { tweak: { initTools: ["mcp__qm__lookup", "Bash"] }, message: /Bash/ },
    { tweak: { initTools: [] }, message: /mcp__qm__lookup/ },
    { tweak: { apiKeySource: "ANTHROPIC_API_KEY" }, message: /ANTHROPIC_API_KEY/ },
    { tweak: { hookEvent: "SessionStart" }, message: /ran a SessionStart hook .*managed settings/ },
    {
      tweak: { managedSettings: { env: { ANTHROPIC_BASE_URL: "https://elsewhere.invalid" } } },
      message: /server-managed settings/,
    },
    { tweak: { settingsReport: {} }, message: /applies settings .*QM refuses/ },
    {
      tweak: { settingsReport: { sources: [{ source: "userSettings", settings: { model: "elsewhere" } }] } },
      message: /applies settings .*QM refuses/,
    },
  ];
  for (const { tweak, message } of cases) {
    const fake = await installFakeClaudeCode(() => ({ text: "must not be used" }), tweak);
    const run = await piSession({ anthropic: TOKEN }, [lookupTool([])]);
    await run.session.prompt("go").finally(() => run.close().finally(fake.restore));
    const failed = lastAssistant(run.session);
    assert.match(failed.errorMessage ?? "", message);
    assert.equal(providerTurnError(failed).retryable, false);
    assert.equal(fake.calls.length, 1);
  }
});

test("an empty server-managed settings object does not block the turn", async (t) => {
  const fake = await installFakeClaudeCode(() => ({ text: "ok" }), { managedSettings: {} });
  t.after(fake.restore);
  const run = await piSession({ anthropic: TOKEN }, []);
  await run.session.prompt("hi");
  await run.close();
  assert.equal(lastAssistant(run.session).stopReason, "stop", lastAssistant(run.session).errorMessage);
});

test("a tool Claude Code cannot load fails the turn before Claude Code starts", async (t) => {
  const fake = await installFakeClaudeCode(() => ({ text: "ok" }));
  t.after(fake.restore);
  const union: ToolDefinition = {
    ...lookupTool([]),
    name: "either",
    parameters: Type.Union([Type.Object({ a: Type.String() }), Type.Object({ b: Type.String() })]),
  };
  const refused = await piSession({ anthropic: TOKEN }, [lookupTool([]), union]);
  await refused.session.prompt("go");
  await refused.close();
  assert.match(
    lastAssistant(refused.session).errorMessage ?? "",
    /either \(its parameters are not a plain object schema\)/,
  );
  assert.equal(fake.calls.length, 0);
});

test("prior history is imported into a private Claude Code transcript and resumed", async (t) => {
  const fake = await installFakeClaudeCode(() => ({ text: "continuing" }));
  t.after(fake.restore);
  const history: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "find alpha" },
        { type: "image", mimeType: "image/png", data: "aGk=" },
      ],
      timestamp: 1,
    },
    assistantFrom(MODEL_ID, [
      { type: "thinking", thinking: "plan", thinkingSignature: "sig-same" },
      { type: "toolCall", id: "toolu_prev", name: "lookup", arguments: { key: "alpha" } },
    ]),
    {
      role: "toolResult",
      toolCallId: "toolu_prev",
      toolName: "lookup",
      content: [{ type: "text", text: "record alpha" }],
      isError: false,
      timestamp: 1,
    },
    assistantFrom("gpt-6.1-sol", [
      { type: "thinking", thinking: "other model reasoning", thinkingSignature: "sig-other" },
      { type: "toolCall", id: "call_9|other provider id", name: "lookup", arguments: { key: "beta" } },
    ]),
    {
      role: "toolResult",
      toolCallId: "call_9|other provider id",
      toolName: "lookup",
      content: [{ type: "text", text: "no such record" }],
      isError: true,
      timestamp: 1,
    },
  ];
  const { session, close } = await piSession({ anthropic: TOKEN }, [lookupTool([])], history);
  await session.prompt("and gamma?");
  await close();
  const call = fake.calls[0]!;
  assert.ok(call.options.resume, "the turn resumes an imported transcript");
  assert.deepEqual(
    call.history.map((turn) => [turn.role, turn.content.map((block) => block.type)]),
    [
      ["user", ["text", "image"]],
      ["assistant", ["thinking", "tool_use"]],
      ["user", ["tool_result"]],
      ["assistant", ["text", "tool_use"]],
      ["user", ["tool_result"]],
    ],
  );
  const [first, sameStep, , otherStep, otherResult] = call.history;
  assert.deepEqual(texts(first!.content), ["find alpha"]);
  assert.equal(sameStep!.content[0]!.signature, "sig-same", "a same-model signature replays");
  assert.deepEqual(otherStep!.content[0], { type: "text", text: "other model reasoning" });
  assert.equal(otherStep!.content[1]!.name, "mcp__qm__lookup");
  assert.match(String(otherStep!.content[1]!.id), /^toolu_[0-9a-f]{32}$/, "foreign ids are made Anthropic-valid");
  assert.equal(otherResult!.content[0]!.tool_use_id, otherStep!.content[1]!.id);
  assert.equal(otherResult!.content[0]!.is_error, true);
});

test("a run that resumes at tool results continues Claude Code from those results", async (t) => {
  const prompts: Block[][] = [];
  const fake = await installFakeClaudeCode((request) => {
    prompts.push(lastUser(request));
    return { text: "picked up" };
  });
  t.after(fake.restore);
  const history: Message[] = [
    { role: "user", content: "look up alpha", timestamp: 1 },
    assistantFrom(MODEL_ID, [{ type: "toolCall", id: "toolu_r", name: "lookup", arguments: { key: "alpha" } }]),
    {
      role: "toolResult",
      toolCallId: "toolu_r",
      toolName: "lookup",
      content: [{ type: "text", text: "record alpha" }],
      isError: false,
      timestamp: 1,
    },
  ];
  const { session, close } = await piSession({ anthropic: TOKEN }, [lookupTool([])], history);
  await session.agent.continue();
  await close();
  assert.deepEqual(texts(fake.calls[0]!.history.at(-1)!.content), ["record alpha"]);
  assert.equal(prompts[0]!.length, 1, "one continuation prompt follows the imported tool result");
  assert.equal(prompts[0]![0]!.type, "text");
  assert.equal(lastAssistant(session).stopReason, "stop");
});

test("a request over edited history supersedes a query parked on a tool call", async (t) => {
  const fake = await installFakeClaudeCode((request) =>
    texts(lastUser(request)).includes("second")
      ? { text: "second answer" }
      : { tools: [{ id: "toolu_end", name: "mcp__qm__lookup", input: { key: "last" } }] },
  );
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, [lookupTool([], true)]);
  await session.prompt("first");
  assert.equal(fake.calls[0]!.closed, false, "Claude Code is still parked on the tool call");
  session.agent.state.messages = session.agent.state.messages.slice(0, 1);
  await session.prompt("second");
  await close();
  assert.equal(fake.calls.length, 2, "the edited history started a fresh query");
  assert.equal(fake.calls[0]!.closed, true, "the superseded query was closed");
  assert.deepEqual(fake.calls[0]!.mcpCalls, [], "it never got a result to send another request with");
});

test("a turn that ends while Claude Code waits on a tool closes the parked query", async (t) => {
  const executed: string[] = [];
  const fake = await installFakeClaudeCode(() => ({
    tools: [{ id: "toolu_end", name: "mcp__qm__lookup", input: { key: "last" } }],
  }));
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, [lookupTool(executed, true)]);
  await session.prompt("finish with a terminating tool");
  assert.deepEqual(executed, ["last"]);
  assert.equal(fake.calls[0]!.closed, false);
  await close();
  assert.equal(fake.calls[0]!.closed, true, "the parked query was closed");
  assert.deepEqual(fake.calls[0]!.mcpCalls, [], "it never got a result to send another request with");
});

test("a failing QM tool reaches Claude Code as an error result", async (t) => {
  const fake = await installFakeClaudeCode((request) =>
    answered(request) ? { text: "noted" } : { tools: [{ id: "toolu_x", name: "mcp__qm__broken", input: {} }] },
  );
  t.after(fake.restore);
  const broken: ToolDefinition = {
    name: "broken",
    label: "Broken",
    description: "Always fails.",
    parameters: Type.Object({}),
    async execute() {
      throw new Error("the sandbox is gone");
    },
  };
  const { session, close } = await piSession({ anthropic: TOKEN }, [broken]);
  await session.prompt("try it");
  await close();
  const result = fake.calls[0]!.mcpCalls[0]!.result as { isError?: boolean; content: Block[] };
  assert.equal(result.isError, true);
  assert.deepEqual(texts(result.content), ["the sandbox is gone"]);
});

test("concurrent turns never share a query, credentials, files or tool results", async (t) => {
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const fake = await installFakeClaudeCode(async (request) => {
    if (answered(request)) return { text: `answer ${texts(lastUser(request)).join(" ")}` };
    if (++arrived === 2) release();
    await barrier;
    return { tools: [{ id: "toolu_same_id", name: "mcp__qm__secret", input: {} }] };
  });
  t.after(fake.restore);
  const secretTool = (secret: string): ToolDefinition => ({
    name: "secret",
    label: "Secret",
    description: "Returns this session's secret.",
    parameters: Type.Object({}),
    async execute() {
      await sleep(secret === "S-ALICE" ? 30 : 0);
      return { content: [{ type: "text", text: secret }], details: {} };
    },
  });
  const alice = await piSession({ anthropic: "sk-ant-oat01-alice" }, [secretTool("S-ALICE")]);
  const bob = await piSession({ anthropic: "sk-ant-oat01-bob" }, [secretTool("S-BOB")]);
  await Promise.all([alice.session.prompt("alice asks"), bob.session.prompt("bob asks")]);
  await Promise.all([alice.close(), bob.close()]);
  const reply = (session: AgentSession) => (lastAssistant(session).content[0] as { text: string }).text;
  assert.equal(reply(alice.session), "answer S-ALICE");
  assert.equal(reply(bob.session), "answer S-BOB");
  const envs = fake.calls.map((call) => call.options.env as Record<string, string>);
  assert.deepEqual(envs.map((env) => env.CLAUDE_CODE_OAUTH_TOKEN).sort(), ["sk-ant-oat01-alice", "sk-ant-oat01-bob"]);
  assert.notEqual(envs[0]!.CLAUDE_CONFIG_DIR, envs[1]!.CLAUDE_CONFIG_DIR);
});

test("an allowed subscription window passes and overage in use fails the turn closed", async (t) => {
  const fake = await installFakeClaudeCode((request) =>
    texts(lastUser(request)).includes("overage")
      ? { rateLimit: { status: "allowed", isUsingOverage: true }, text: "must not be accepted" }
      : { rateLimit: { status: "allowed", isUsingOverage: false, overageStatus: "rejected" }, text: "fine" },
  );
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, []);
  await session.prompt("normal");
  assert.equal(lastAssistant(session).stopReason, "stop");
  await session.prompt("overage");
  await close();
  const failed = lastAssistant(session);
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.providerError?.code, "overage_in_use");
  assert.equal(providerTurnError(failed).retryable, false);
});

test("provider failures keep Claude Code's wording and map to QM's error codes without invented statuses", async () => {
  const cases: Array<[FakeReply, string, boolean, number | undefined]> = [
    [
      { error: { kind: "billing_error", status: 400, text: "API Error: 400 You're out of extra usage." } },
      "bad_request",
      false,
      400,
    ],
    [
      { error: { kind: "billing_error", text: "API Error: You're out of extra usage." } },
      "bad_request",
      false,
      undefined,
    ],
    [
      { error: { kind: "authentication_failed", status: 401, text: "API Error: 401 OAuth token has expired." } },
      "auth",
      false,
      401,
    ],
    [{ error: { kind: "rate_limit", status: 429, text: "API Error: 429 rate limited" } }, "rate_limit", true, 429],
    [{ error: { kind: "overloaded", text: "API Error: overloaded" } }, "transient", true, undefined],
    [
      { error: { kind: "unknown", status: 400, text: "API Error: 400 Invalid signature in thinking block" } },
      "bad_request",
      false,
      400,
    ],
    [{ refusal: true, text: "I can't help with that." }, "refusal", false, undefined],
  ];
  for (const [reply, code, retryable, status] of cases) {
    const fake = await installFakeClaudeCode(() => reply);
    const { session, close } = await piSession({ anthropic: TOKEN }, []);
    await session.agent
      .prompt({ role: "user", content: "hi", timestamp: Date.now() })
      .catch(() => undefined)
      .finally(() => close().finally(fake.restore));
    const failed = lastAssistant(session);
    if (reply.error) assert.equal(failed.errorMessage, reply.error.text);
    assert.equal(failed.providerError?.status, status);
    const turnError = providerTurnError(failed);
    assert.equal(turnError.code, code, JSON.stringify(failed.providerError));
    assert.equal(turnError.retryable, retryable);
  }
});

test("a Claude Code process that dies without a result fails the step with Claude Code's exit evidence", async (t) => {
  const fake = await installFakeClaudeCode(() => ({ endWithoutResult: true }));
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, []);
  await session.agent.prompt({ role: "user", content: "hi", timestamp: Date.now() }).catch(() => undefined);
  await close();
  assert.match(lastAssistant(session).errorMessage ?? "", /SIGKILL/);
});

test("a steer queued during a tool call reaches Claude Code with that tool's result", async (t) => {
  const box: { session?: AgentSession } = {};
  const seen: Block[][] = [];
  const fake = await installFakeClaudeCode((request) => {
    if (!answered(request)) return { tools: [{ id: "toolu_s", name: "mcp__qm__lookup", input: { key: "delta" } }] };
    seen.push(lastUser(request));
    return { text: "seen" };
  });
  t.after(fake.restore);
  const steeringTool: ToolDefinition = {
    ...lookupTool([]),
    async execute() {
      await box.session!.steer("also include epsilon");
      return { content: [{ type: "text", text: "record delta" }], details: {} };
    },
  };
  const built = await piSession({ anthropic: TOKEN }, [steeringTool]);
  box.session = built.session;
  await built.session.prompt("look up delta");
  await built.close();
  assert.deepEqual(new Set(texts(seen[0]!)), new Set(["record delta", "also include epsilon"]));
  assert.equal(fake.calls.length, 1, "the steer joined the live query instead of starting another");
});

test("QM's request hook sees every model call; its system and tools shape a fresh query and its added content reaches a continued step", async (t) => {
  const prompts: Block[][] = [];
  const fake = await installFakeClaudeCode((request) => {
    prompts.push(lastUser(request));
    return answered(request)
      ? { text: "ok" }
      : { tools: [{ id: "toolu_p", name: "mcp__qm__lookup", input: { key: "z" } }] };
  });
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, [lookupTool([])]);
  const seen: Array<{ system: string; tools: Array<{ name: string }>; model: string }> = [];
  session.agent.onPayload = async (payload) => {
    const body = structuredClone(payload) as {
      system: string;
      model: string;
      tools: Array<{ name: string }>;
      messages: Array<{ role: string; content: Block[] }>;
    };
    seen.push(structuredClone(body));
    body.messages.at(-1)!.content.push({ type: "text", text: "[document text: quarterly.pdf]" });
    return { ...body, system: `${body.system}\nHook note.` };
  };
  await session.prompt("summarize the attachment");
  await close();
  assert.equal(seen.length, 2, "one hook call per model request, as with Pi's own providers");
  assert.equal(seen[0]!.system, session.systemPrompt);
  assert.deepEqual(
    seen[0]!.tools.map((tool) => tool.name),
    ["mcp__qm__lookup"],
  );
  assert.equal(seen[0]!.model, "claude-sonnet-5");
  assert.deepEqual(texts(prompts[0]!), ["summarize the attachment", "[document text: quarterly.pdf]"]);
  assert.deepEqual(
    texts(prompts[1]!),
    ["record z", "[document text: quarterly.pdf]"],
    "a continued step carries what the hook added",
  );
  assert.equal(fake.calls[0]!.options.systemPrompt, `${session.systemPrompt}\nHook note.`);
  assert.equal(fake.calls.length, 1);
});

test("request hook fields and forced tools Claude Code cannot send fail the step before Claude Code starts", async (t) => {
  const fake = await installFakeClaudeCode(() => ({ text: "must not be used" }));
  t.after(fake.restore);
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ metadata: { user_id: "hook" } }, /cannot send request fields .*: metadata$/],
    [{ output_config: { effort: "high", format: { type: "json_schema" } } }, /: output_config\.format$/],
    [{ tool_choice: { type: "tool", name: "missing" } }, /forces the tool missing, which this request does not serve/],
  ];
  for (const [added, message] of cases) {
    const run = await piSession({ anthropic: TOKEN }, [lookupTool([])]);
    run.session.agent.onPayload = async (payload) => ({ ...(payload as object), ...added });
    await run.session.prompt("go");
    await run.close();
    const failed = lastAssistant(run.session);
    assert.match(failed.errorMessage ?? "", message);
    assert.equal(providerTurnError(failed).retryable, false);
  }
  assert.equal(fake.calls.length, 0, "Claude Code never started");
});

test("a request hook's forced tool reaches Claude Code under QM's served name, and a step without it starts a new query", async (t) => {
  const executed: string[] = [];
  const fake = await installFakeClaudeCode((request) =>
    request.messages.some((message) => message.content.some((block) => block.type === "tool_result"))
      ? { text: "done" }
      : { tools: [{ id: "toolu_forced", name: "mcp__qm__lookup", input: { key: "kappa" } }] },
  );
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, [lookupTool(executed)]);
  let requests = 0;
  session.agent.onPayload = async (payload) =>
    ++requests === 1 ? { ...(payload as object), tool_choice: { type: "tool", name: "lookup" } } : undefined;
  await session.prompt("look up kappa");
  await close();
  const forced = fake.calls.map(
    (call) =>
      (JSON.parse(String(call.options.env?.CLAUDE_CODE_EXTRA_BODY ?? "{}")) as { tool_choice?: unknown }).tool_choice,
  );
  assert.deepEqual(forced, [{ type: "tool", name: "mcp__qm__lookup" }, undefined]);
  assert.deepEqual(executed, ["kappa"]);
  assert.deepEqual(lastAssistant(session).content, [{ type: "text", text: "done" }]);
});

test("QM's thinking level reaches the wire through Claude Code as Pi's Anthropic provider sends it", async (t) => {
  const fake = await installFakeClaudeCode(() => ({ text: "ok" }));
  t.after(fake.restore);
  const direct: Array<{ body: Record<string, unknown>; beta: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    direct.push({ body, beta: new Headers(init?.headers).get("anthropic-beta") ?? "" });
    return new Response(anthropicMessage(String(body.model), [{ type: "text", text: "ok" }], "end_turn"), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const send = async (keys: Parameters<typeof piSession>[0], modelId: string, level: ThinkingLevel) => {
    const run = await piSession(keys, [], [], { modelId });
    run.session.setThinkingLevel(level);
    await run.session.prompt("hi");
    await run.close();
  };
  const cases: Array<[string, ThinkingLevel]> = [
    ["claude-opus-5-5", "high"],
    ["claude-opus-5-5", "off"],
    ["claude-sonnet-5", "low"],
    ["claude-sonnet-5", "off"],
    ["claude-haiku-4-5", "medium"],
  ];
  for (const [modelId, level] of cases) {
    await send({ anthropic: "sk-ant-api03-metered" }, modelId, level);
    await send({ anthropic: TOKEN }, modelId, level);
    const pi = direct.at(-1)!;
    const { options } = fake.calls.at(-1)!;
    const env = options.env as Record<string, string>;
    const thinking = env.CLAUDE_CODE_EXTRA_BODY
      ? (JSON.parse(env.CLAUDE_CODE_EXTRA_BODY) as { thinking: unknown }).thinking
      : wireThinking(options.thinking);
    const label = `${modelId} at ${level}`;
    assert.deepEqual(thinking, pi.body.thinking ?? { type: "disabled" }, label);
    const piEffort = (pi.body.output_config as { effort?: string } | undefined)?.effort;
    assert.equal(options.effort, piEffort ?? "high", label);
    assert.equal(env.ANTHROPIC_BETAS ?? "", pi.beta.includes("thinking-binding") ? pi.beta : "", label);
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, String(pi.body.max_tokens), label);
  }
});
