import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { test } from "node:test";
import { Type } from "typebox";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  defaultModel,
  defaultWebuiModelIds,
  modelIdReserved,
  resolveModel,
  selectableBaseModels,
} from "../src/model/pi-models.ts";
import { modelBilling, routeLabel, servedBySubscription } from "../src/model/model-route.ts";
import { providerTurnError } from "../src/model/provider-error.ts";
import { installFakeClaudeCode, processAlive, type FakeReply, type FakeRequest } from "./support/fake-claude-code.ts";
import {
  CLAUDE_CODE_TEST_SYSTEM as SYSTEM,
  claudeCodeSession as piSession,
  lastAssistant,
  lookupTool,
} from "./support/claude-code-session.ts";

const TOKEN = "sk-ant-oat01-claude-code-test";
const MODEL_ID = "claude-code/claude-sonnet-5";

function textOf(request: FakeRequest, role: "user" | "assistant", at = -1): string {
  const turn = request.messages.filter((message) => message.role === role).at(at);
  return JSON.stringify(turn?.content ?? []);
}

test("claude-code models resolve only by explicit id, stay out of catalogs, and bill as a subscription", () => {
  const model = resolveModel(MODEL_ID);
  assert.equal(model?.provider, "claude-code");
  assert.equal(model?.api, "claude-code");
  assert.equal(resolveModel("claude-code/gpt-6.1-sol"), undefined, "only Anthropic models run through Claude Code");
  assert.ok(modelIdReserved(MODEL_ID));
  const listed = [...selectableBaseModels(true).map((entry) => entry.id), ...defaultWebuiModelIds(), defaultModel()];
  assert.ok(!listed.some((id) => id.startsWith("claude-code/")), "never offered or chosen by default");
  assert.ok(servedBySubscription(model!, { anthropic: "sk-ant-api03-metered" }), "this route never bills a key");
  assert.match(
    routeLabel({ modelId: MODEL_ID, billing: modelBilling(false, false, true) }),
    /organization's subscription/,
  );
  assert.match(routeLabel({ modelId: MODEL_ID, billing: modelBilling(false, true, true) }), /person's own account/);
});

test("a multi-tool turn executes QM tools only through Pi and pairs every result with its tool_use id", async (t) => {
  const executed: string[] = [];
  const fake = await installFakeClaudeCode((request) =>
    request.messages.at(-1)?.content.some((block) => block.type === "tool_result")
      ? { text: `done ${textOf(request, "user")}`, usage: { input: 30, output: 7, cacheRead: 20 } }
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
  const events: string[] = [];
  session.subscribe((event) => {
    if (event.type === "message_update") events.push(event.assistantMessageEvent.type);
  });
  await session.prompt("Compare alpha and beta");
  const call = fake.calls[0]!;
  const childBeforeClose = call.child;
  await close();

  assert.deepEqual(executed.sort(), ["alpha", "beta"], "each tool ran exactly once, in QM's process");
  assert.deepEqual(
    Object.fromEntries(call.mcpCalls.map((c) => [c.id, JSON.stringify(c.result)])),
    {
      toolu_a: JSON.stringify({ content: [{ type: "text", text: "record alpha" }] }),
      toolu_b: JSON.stringify({ content: [{ type: "text", text: "record beta" }] }),
    },
    "results pair by tool_use id even when Claude Code calls them in reverse order",
  );
  const finalText = lastAssistant(session).content.find((block) => block.type === "text");
  assert.match(
    finalText && "text" in finalText ? finalText.text : "",
    /record alpha.*record beta|record beta.*record alpha/,
  );
  const toolStep = session.messages.find(
    (message) => message.role === "assistant" && message.stopReason === "toolUse",
  ) as AssistantMessage;
  assert.deepEqual(
    toolStep.content.map((block) => block.type),
    ["thinking", "text", "toolCall", "toolCall"],
  );
  assert.equal((toolStep.content[0] as { thinkingSignature?: string }).thinkingSignature, "sig-1");
  assert.equal(toolStep.usage.input, 12);
  assert.equal(lastAssistant(session).usage.cacheRead, 20);
  assert.ok(lastAssistant(session).usage.cost.total > 0);
  assert.ok(events.filter((type) => type === "text_delta").length > 2, "text streamed in pieces");
  assert.ok(events.includes("toolcall_delta") && events.includes("toolcall_end"));

  assert.equal(fake.calls.length, 1, "one Claude Code query served the whole turn");
  assert.equal(
    call.options.systemPrompt,
    session.systemPrompt,
    "QM's system prompt is sent verbatim as the system prompt",
  );
  assert.ok(String(call.options.systemPrompt).includes(SYSTEM));
  assert.deepEqual(call.options.tools, [], "no Claude Code built-in tools");
  assert.deepEqual(call.options.settingSources, [], "no user, project or local settings, hooks or CLAUDE.md");
  assert.equal(call.options.strictMcpConfig, true);
  assert.equal(call.options.permissionMode, "dontAsk");
  assert.deepEqual(call.options.allowedTools, ["mcp__qm__lookup"]);
  assert.deepEqual(call.options.skills, []);
  assert.deepEqual(
    call.listedTools.map((tool) => [tool.name, tool.description, tool.inputSchema]),
    [["lookup", lookupTool([]).description, JSON.parse(JSON.stringify(lookupTool([]).parameters))]],
    "tool descriptions and schemas reach Claude Code unchanged",
  );

  const env = call.options.env as Record<string, string>;
  assert.deepEqual(Object.keys(env).sort(), [
    "CLAUDE_AGENT_SDK_CLIENT_APP",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS",
    "CLAUDE_CODE_SILENT_TURN_REMINDER",
    "CLAUDE_CONFIG_DIR",
    "DISABLE_AUTO_COMPACT",
    "ENABLE_CLAUDEAI_MCP_SERVERS",
    "HOME",
    "PATH",
    "TMPDIR",
  ]);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(env.HOME, env.CLAUDE_CONFIG_DIR);
  assert.notEqual(env.HOME, homedir());
  assert.ok(!JSON.stringify(env).includes("ambient") && !JSON.stringify(env).includes("secret@db"));
  assert.ok(!processAlive(childBeforeClose), "the Claude Code process is gone after the turn");
  assert.ok(!existsSync(env.CLAUDE_CONFIG_DIR!), "its private config dir is removed");
});

test("metered or missing Anthropic credentials fail closed before Claude Code starts", async (t) => {
  const fake = await installFakeClaudeCode(() => ({ text: "should never run" }));
  t.after(fake.restore);
  const metered = await piSession({ anthropic: "sk-ant-api03-metered" }, []);
  await metered.session.prompt("hi");
  await metered.close();
  const refused = lastAssistant(metered.session);
  assert.equal(refused.stopReason, "error");
  assert.match(refused.errorMessage ?? "", /subscription OAuth token; this route never uses a metered API key/);
  assert.equal(providerTurnError(refused).code, "auth");

  const missing = await piSession({ openai: "sk-openai" }, []);
  await assert.rejects(missing.session.prompt("hi"), /claude-code/);
  await missing.close();
  assert.equal(fake.calls.length, 0, "Claude Code never started");
});

test("Claude Code tool calls QM did not serve never reach QM, and a foreign tool or API key fails the turn", async (t) => {
  const executed: string[] = [];
  const fake = await installFakeClaudeCode((request) =>
    request.messages.at(-1)?.content.some((block) => block.type === "tool_result")
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
  fake.restore();

  for (const tweak of [{ initTools: ["mcp__qm__lookup", "Bash"] }, { apiKeySource: "ANTHROPIC_API_KEY" }]) {
    const guarded = await installFakeClaudeCode(() => ({ text: "must not be used" }), tweak);
    const run = await piSession({ anthropic: TOKEN }, [lookupTool([])]);
    await run.session.prompt("go");
    await run.close();
    guarded.restore();
    const failed = lastAssistant(run.session);
    assert.equal(failed.stopReason, "error");
    assert.match(failed.errorMessage ?? "", /exposed tools QM did not serve: Bash|API key source ANTHROPIC_API_KEY/);
    assert.ok(!processAlive(guarded.calls[0]!.child));
  }
});

test("prior history is imported into a private Claude Code transcript and resumed", async (t) => {
  const fake = await installFakeClaudeCode(() => ({ text: "continuing" }));
  t.after(fake.restore);
  const now = Date.now();
  const sameModel = resolveModel(MODEL_ID)!;
  const history: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "find alpha" },
        { type: "image", mimeType: "image/png", data: "aGk=" },
      ],
      timestamp: now,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan", thinkingSignature: "sig-same" },
        { type: "toolCall", id: "toolu_prev", name: "lookup", arguments: { key: "alpha" } },
      ],
      api: sameModel.api,
      provider: sameModel.provider,
      model: sameModel.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: now,
    },
    {
      role: "toolResult",
      toolCallId: "toolu_prev",
      toolName: "lookup",
      content: [{ type: "text", text: "record alpha" }],
      isError: false,
      timestamp: now,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "other model reasoning", thinkingSignature: "sig-other" },
        { type: "text", text: "alpha found" },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-6.1-sol",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: now,
    },
  ];
  const { session, close } = await piSession({ anthropic: TOKEN }, [lookupTool([])], history);
  await session.prompt("and beta?");
  await close();
  const call = fake.calls[0]!;
  assert.ok(call.options.resume, "the turn resumes an imported transcript");
  assert.ok(call.transcriptFile?.startsWith(String((call.options.env as Record<string, string>).CLAUDE_CONFIG_DIR)));
  assert.deepEqual(
    call.history.map((turn) => [turn.role, turn.content.map((block) => block.type)]),
    [
      ["user", ["text", "image"]],
      ["assistant", ["thinking", "tool_use"]],
      ["user", ["tool_result"]],
      ["assistant", ["text", "text"]],
    ],
  );
  const flat = JSON.stringify(call.history);
  assert.ok(flat.includes('"name":"mcp__qm__lookup"'), "tool names match the served MCP names");
  assert.ok(flat.includes("sig-same") && !flat.includes("sig-other"), "only same-model signatures replay");
  assert.ok(flat.includes("other model reasoning"), "other models' reasoning stays visible as text");
  assert.equal(lastAssistant(session).stopReason, "stop");
});

test("aborting a turn stops Claude Code and removes its files", async (t) => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const fake = await installFakeClaudeCode(() => {
    started();
    return { hang: true };
  });
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, [lookupTool([])]);
  const prompting = session.prompt("slow");
  await running;
  const call = fake.calls[0]!;
  assert.ok(processAlive(call.child));
  await session.abort();
  await prompting.catch(() => undefined);
  const dir = String((call.options.env as Record<string, string>).CLAUDE_CONFIG_DIR);
  for (let i = 0; i < 100 && (processAlive(call.child) || existsSync(dir)); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!processAlive(call.child), "the child was killed");
  assert.ok(!existsSync(dir), "its files were removed");
  assert.equal(lastAssistant(session).stopReason, "aborted");
  await close();
});

test("a turn that ends while Claude Code waits on a tool closes the parked query", async (t) => {
  const executed: string[] = [];
  const fake = await installFakeClaudeCode(() => ({
    tools: [{ id: "toolu_end", name: "mcp__qm__lookup", input: { key: "last" } }],
  }));
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, [lookupTool(executed, true)]);
  await session.prompt("finish with a terminating tool");
  const call = fake.calls[0]!;
  assert.deepEqual(executed, ["last"]);
  assert.ok(processAlive(call.child), "Claude Code is still parked on the tool call");
  await close();
  assert.ok(!processAlive(call.child));
  assert.equal(call.closed, true);
  assert.match(JSON.stringify(call.mcpCalls), /QM ended the turn/, "the waiting tool call was released");
});

test("concurrent turns never share a query, credentials, files or tool results", async (t) => {
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const fake = await installFakeClaudeCode(async (request) => {
    if (request.messages.at(-1)?.content.some((block) => block.type === "tool_result"))
      return { text: `answer ${textOf(request, "user")}` };
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
      await new Promise((resolve) => setTimeout(resolve, secret === "S-ALICE" ? 30 : 0));
      return { content: [{ type: "text", text: secret }], details: {} };
    },
  });
  const alice = await piSession({ anthropic: "sk-ant-oat01-alice" }, [secretTool("S-ALICE")]);
  const bob = await piSession({ anthropic: "sk-ant-oat01-bob" }, [secretTool("S-BOB")]);
  await Promise.all([alice.session.prompt("alice asks"), bob.session.prompt("bob asks")]);
  await Promise.all([alice.close(), bob.close()]);
  const text = (session: AgentSession) => JSON.stringify(lastAssistant(session).content);
  assert.ok(text(alice.session).includes("S-ALICE") && !text(alice.session).includes("S-BOB"));
  assert.ok(text(bob.session).includes("S-BOB") && !text(bob.session).includes("S-ALICE"));
  const envs = fake.calls.map((call) => call.options.env as Record<string, string>);
  assert.deepEqual(envs.map((env) => env.CLAUDE_CODE_OAUTH_TOKEN).sort(), ["sk-ant-oat01-alice", "sk-ant-oat01-bob"]);
  assert.notEqual(envs[0]!.CLAUDE_CONFIG_DIR, envs[1]!.CLAUDE_CONFIG_DIR);
});

test("an overage signal from Claude fails the turn closed and stops the query", async (t) => {
  const fake = await installFakeClaudeCode(() => ({
    rateLimit: { status: "allowed", isUsingOverage: true, overageStatus: "allowed" },
    text: "this text must not be accepted",
  }));
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, []);
  await session.prompt("hi");
  await close();
  const failed = lastAssistant(session);
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.providerError?.code, "overage_in_use");
  assert.match(failed.errorMessage ?? "", /refuses metered usage/);
  const error = providerTurnError(failed);
  assert.equal(error.retryable, false);
  assert.ok(!processAlive(fake.calls[0]!.child));
});

test("provider failures keep Claude's own wording with a typed status and are not retried as unknown", async (t) => {
  const cases: Array<[FakeReply["error"], string, boolean]> = [
    [{ kind: "billing_error", status: 400, text: "API Error: 400 You're out of extra usage." }, "bad_request", false],
    [{ kind: "authentication_failed", status: 401, text: "API Error: 401 OAuth token has expired." }, "auth", false],
  ];
  for (const [error, code, retryable] of cases) {
    const fake = await installFakeClaudeCode(() => ({ error }));
    const { session, close } = await piSession({ anthropic: TOKEN }, []);
    await session.prompt("hi");
    await close();
    fake.restore();
    const failed = lastAssistant(session);
    assert.equal(failed.errorMessage, error!.text);
    assert.equal(failed.providerError?.status, error!.status);
    const turnError = providerTurnError(failed);
    assert.equal(turnError.code, code);
    assert.equal(turnError.retryable, retryable);
    assert.ok(!/paid extra usage|billed/i.test(turnError.message), "no invented billing claim");
    assert.equal(fake.calls.length, 1, "a rejected request is not re-sent");
  }
  t.diagnostic("billing and auth failures map to typed, non-retryable codes");
});

test("a steer queued during a tool call reaches Claude Code with that tool's result", async (t) => {
  const box: { session?: AgentSession } = {};
  const fake = await installFakeClaudeCode((request) =>
    request.messages.at(-1)?.content.some((block) => block.type === "tool_result")
      ? { text: `saw ${textOf(request, "user")}` }
      : { tools: [{ id: "toolu_s", name: "mcp__qm__lookup", input: { key: "delta" } }] },
  );
  t.after(fake.restore);
  const steeringTool: ToolDefinition = {
    ...lookupTool([]),
    async execute(_id, params) {
      await box.session!.steer("also include epsilon");
      return { content: [{ type: "text", text: `record ${(params as { key: string }).key}` }], details: {} };
    },
  };
  const built = await piSession({ anthropic: TOKEN }, [steeringTool]);
  box.session = built.session;
  const session = built.session;
  await session.prompt("look up delta");
  await built.close();
  const finalText = JSON.stringify(lastAssistant(session).content);
  assert.match(finalText, /tool_result.*record delta.*also include epsilon/);
  assert.equal(fake.calls.length, 1, "the steer joined the live query instead of starting another");
});

test("QM's request hook sees every model call and what it returns is what Claude Code receives", async (t) => {
  const prompts: string[] = [];
  const fake = await installFakeClaudeCode((request) => {
    prompts.push(textOf(request, "user", 0));
    return request.messages.at(-1)?.content.some((block) => block.type === "tool_result")
      ? { text: "ok" }
      : { tools: [{ id: "toolu_p", name: "mcp__qm__lookup", input: { key: "zeta" } }] };
  });
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, [lookupTool([])]);
  const seen: unknown[] = [];
  session.agent.onPayload = async (payload) => {
    seen.push(structuredClone(payload));
    const body = payload as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    body.messages.at(-1)!.content.push({ type: "text", text: "[document text: quarterly.pdf]" });
    return body;
  };
  await session.prompt("summarize the attachment");
  await close();
  assert.equal(seen.length, 2, "one hook call per model request, as with Pi's own providers");
  const first = seen[0] as { system: string; tools: Array<{ name: string }>; model: string };
  assert.equal(first.system, session.systemPrompt);
  assert.deepEqual(
    first.tools.map((tool) => tool.name),
    ["mcp__qm__lookup"],
  );
  assert.equal(first.model, "claude-sonnet-5");
  assert.match(prompts[0]!, /summarize the attachment.*\[document text: quarterly\.pdf\]/);
  assert.equal(fake.calls.length, 1);
});

test("a QM tool Claude Code would truncate, drop or fail to load fails the turn instead of running without it", async (t) => {
  const fake = await installFakeClaudeCode(() => ({ text: "must not be used" }));
  t.after(fake.restore);
  const long: ToolDefinition = { ...lookupTool([]), name: "long_doc", description: `${"D".repeat(4100)} end` };
  const union: ToolDefinition = {
    ...lookupTool([]),
    name: "either",
    parameters: Type.Union([Type.Object({ a: Type.String() }), Type.Object({ b: Type.String() })]),
  };
  for (const [tool, reason] of [
    [long, /long_doc \(Claude Code truncates tool descriptions over 4096 characters\)/],
    [union, /either \(its parameters are not a plain object schema\)/],
  ] as const) {
    const run = await piSession({ anthropic: TOKEN }, [lookupTool([]), tool]);
    await run.session.prompt("go");
    await run.close();
    assert.match(lastAssistant(run.session).errorMessage ?? "", reason);
  }
  assert.equal(fake.calls.length, 0, "refused before Claude Code started");
  fake.restore();

  const dropped = await installFakeClaudeCode(() => ({ text: "must not be used" }), { initTools: [] });
  const run = await piSession({ anthropic: TOKEN }, [lookupTool([])]);
  await run.session.prompt("go");
  await run.close();
  dropped.restore();
  assert.match(lastAssistant(run.session).errorMessage ?? "", /did not load these QM tools: mcp__qm__lookup/);
});
