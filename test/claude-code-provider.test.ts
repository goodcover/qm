import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import { Type } from "typebox";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import {
  auxiliaryModelFor,
  defaultInteractiveThinkingLevel,
  defaultModel,
  defaultWebuiModelIds,
  modelIdReserved,
  resolveModel,
  selectableBaseModels,
} from "../src/model/pi-models.ts";
import { modelBilling, routeLabel, servedBySubscription } from "../src/model/model-route.ts";
import { providerTurnError } from "../src/model/provider-error.ts";
import { setProviderBaseUrls } from "../src/model/provider-endpoints.ts";
import { zeroUsage } from "../src/model/model-runtime.ts";
import { resolveIndividualAuthRouting } from "../src/core/individual-auth-routing.ts";
import { BrowserCompletionError, nativeBrowserCompletion } from "../src/model/browser-completion.ts";
import { installFakeClaudeCode, type Block, type FakeReply, type FakeRequest } from "./support/fake-claude-code.ts";
import {
  CLAUDE_CODE_TEST_SYSTEM as SYSTEM,
  claudeCodeSession as piSession,
  lastAssistant,
  lookupTool,
} from "./support/claude-code-session.ts";

const TOKEN = "sk-ant-oat01-claude-code-test";
const MODEL_ID = "claude-code/claude-sonnet-5";

function lastUser(request: FakeRequest): Block[] {
  return request.messages.findLast((message) => message.role === "user")?.content ?? [];
}

function answered(request: FakeRequest): boolean {
  return lastUser(request).some((block) => block.type === "tool_result");
}

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

test("claude-code models resolve only by explicit id and stay out of catalogs and defaults", () => {
  const model = resolveModel(MODEL_ID);
  assert.equal(model?.provider, "claude-code");
  assert.equal(model?.api, "claude-code");
  assert.equal(resolveModel("claude-code/gpt-6.1-sol"), undefined, "only Anthropic models run through Claude Code");
  assert.ok(modelIdReserved(MODEL_ID));
  const listed = [...selectableBaseModels(true).map((entry) => entry.id), ...defaultWebuiModelIds(), defaultModel()];
  assert.ok(!listed.some((id) => id.startsWith("claude-code/")));
  assert.equal(defaultInteractiveThinkingLevel(model!), "low", "same default effort as native Anthropic");
  assert.equal(resolveModel(auxiliaryModelFor("claude-code/claude-opus-5"))?.provider, "claude-code");
});

test("claude-code routes are labelled as subscription usage", () => {
  assert.ok(servedBySubscription(resolveModel(MODEL_ID)!, { anthropic: TOKEN }));
  assert.equal(
    routeLabel({ modelId: MODEL_ID, billing: modelBilling(false, false, true) }),
    `${MODEL_ID} (billed to the organization's subscription)`,
  );
});

test("personal model accounts never route to claude-code", () => {
  const oauth = { provider: "anthropic", kind: "oauth", oauth: {}, updatedAt: 1 } as const;
  const apiKey = { provider: "anthropic", kind: "apikey", apiKey: "sk-ant-api03-personal", updatedAt: 1 } as const;
  assert.equal(resolveIndividualAuthRouting(oauth, null, MODEL_ID), null);
  assert.equal(resolveIndividualAuthRouting(apiKey, null, MODEL_ID), null);
});

test("browser inference refuses claude-code models", async () => {
  await assert.rejects(
    nativeBrowserCompletion({
      selection: { account: "company", model: MODEL_ID } as Parameters<typeof nativeBrowserCompletion>[0]["selection"],
      companyProviderKeys: { anthropic: TOKEN },
      actorId: "U1",
      body: { messages: [] },
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof BrowserCompletionError && error.status === 422,
  );
});

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
  const events: string[] = [];
  session.subscribe((event) => {
    if (event.type === "message_update") events.push(event.assistantMessageEvent.type);
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
  assert.ok(events.includes("text_delta") && events.includes("toolcall_delta") && events.includes("toolcall_end"));

  assert.equal(fake.calls.length, 1, "one Claude Code query served the whole turn");
  assert.equal(call.options.systemPrompt, session.systemPrompt, "QM's system prompt is the system prompt, verbatim");
  assert.ok(String(call.options.systemPrompt).includes(SYSTEM));
  assert.deepEqual(call.options.tools, [], "no Claude Code built-in tools");
  assert.deepEqual(call.options.settingSources, [], "no user, project or local settings, hooks or CLAUDE.md");
  assert.equal(call.options.permissionMode, "dontAsk");
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
  assert.deepEqual(await fake.leftovers(), []);
});

test("metered or missing Anthropic credentials, or an operator Anthropic base URL, fail before Claude Code starts", async (t) => {
  const fake = await installFakeClaudeCode(() => ({ text: "should never run" }));
  t.after(fake.restore);
  const metered = await piSession({ anthropic: "sk-ant-api03-metered" }, []);
  await metered.session.prompt("hi");
  await metered.close();
  assert.match(lastAssistant(metered.session).errorMessage ?? "", /never uses a metered API key/);
  assert.equal(providerTurnError(lastAssistant(metered.session)).code, "auth");

  setProviderBaseUrls({ anthropic: "https://egress.invalid" });
  t.after(() => setProviderBaseUrls({}));
  const proxied = await piSession({ anthropic: TOKEN }, []);
  await proxied.session.prompt("hi");
  await proxied.close();
  assert.match(lastAssistant(proxied.session).errorMessage ?? "", /through https:\/\/egress\.invalid/);
  setProviderBaseUrls({});

  const missing = await piSession({ openai: "sk-openai" }, []);
  await assert.rejects(missing.session.prompt("hi"), /claude-code/);
  await missing.close();
  assert.equal(fake.calls.length, 0, "Claude Code never started");
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
  assert.deepEqual(await fake.leftovers(), []);
});

test("a mismatched tool list or an API key source fails the turn closed and is not retried", async () => {
  const cases = [
    { tweak: { initTools: ["mcp__qm__lookup", "Bash"] }, message: /extra \[Bash\], missing \[\]/ },
    { tweak: { initTools: [] }, message: /extra \[\], missing \[mcp__qm__lookup\]/ },
    { tweak: { apiKeySource: "ANTHROPIC_API_KEY" }, message: /API key source ANTHROPIC_API_KEY/ },
  ];
  for (const { tweak, message } of cases) {
    const fake = await installFakeClaudeCode(() => ({ text: "must not be used" }), tweak);
    const run = await piSession({ anthropic: TOKEN }, [lookupTool([])]);
    await run.session.prompt("go").finally(() => run.close().finally(fake.restore));
    const failed = lastAssistant(run.session);
    assert.match(failed.errorMessage ?? "", message);
    assert.equal(providerTurnError(failed).retryable, false);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(await fake.leftovers(), []);
  }
});

test("tools Claude Code cannot load fail before it starts; long descriptions are served whole", async (t) => {
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

  const description = `${"D".repeat(6000)} end`;
  const long = await piSession({ anthropic: TOKEN }, [{ ...lookupTool([]), name: "long_doc", description }]);
  await long.session.prompt("go");
  await long.close();
  assert.equal(lastAssistant(long.session).stopReason, "stop");
  assert.equal(fake.calls[0]!.listedTools[0]!.description, description);
  assert.equal(
    (fake.calls[0]!.options.env as Record<string, string>).CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH,
    String(description.length),
  );
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
  assert.equal((call.options.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.deepEqual(await fake.leftovers(), []);
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
  assert.deepEqual(texts(prompts[0]!), ["[system] The run resumed after the tool results above. Continue the task."]);
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
  assert.deepEqual(fake.calls[0]!.mcpCalls[0]!.result, {
    content: [{ type: "text", text: "Superseded by a new request" }],
    isError: true,
  });
  assert.deepEqual(await fake.leftovers(), []);
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
  assert.deepEqual(fake.calls[0]!.mcpCalls[0]!.result, {
    content: [{ type: "text", text: "QM ended the turn" }],
    isError: true,
  });
  assert.deepEqual(await fake.leftovers(), []);
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
      await new Promise((resolve) => setTimeout(resolve, secret === "S-ALICE" ? 30 : 0));
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
  assert.deepEqual(await fake.leftovers(), []);
});

test("subscription limits are recorded on the step, and overage in use fails the turn closed", async (t) => {
  const allowed = { status: "allowed", isUsingOverage: false, overageStatus: "rejected" };
  const fake = await installFakeClaudeCode((request) =>
    texts(lastUser(request)).includes("overage")
      ? { rateLimit: { status: "allowed", isUsingOverage: true }, text: "must not be accepted" }
      : { rateLimit: allowed, text: "fine" },
  );
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, []);
  await session.prompt("normal");
  assert.deepEqual(
    lastAssistant(session).diagnostics?.map((diagnostic) => [diagnostic.type, diagnostic.details]),
    [["claude_code_rate_limit", allowed]],
  );
  await session.prompt("overage");
  await close();
  const failed = lastAssistant(session);
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.providerError?.code, "overage_in_use");
  assert.equal(providerTurnError(failed).retryable, false);
  assert.deepEqual(await fake.leftovers(), []);
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

test("a Claude Code process that exits without a result fails the step with its exit status", async (t) => {
  const fake = await installFakeClaudeCode(() => ({ endWithoutResult: true }));
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, []);
  await session.agent.prompt({ role: "user", content: "hi", timestamp: Date.now() }).catch(() => undefined);
  await close();
  assert.match(lastAssistant(session).errorMessage ?? "", /ended without a result \(exit code none, signal SIGKILL\)/);
  assert.deepEqual(await fake.leftovers(), []);
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

test("QM's request hook sees every model call and what it returns is what Claude Code receives", async (t) => {
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
  assert.equal(fake.calls[0]!.options.systemPrompt, `${session.systemPrompt}\nHook note.`);
  assert.equal(fake.calls.length, 1);
});

test("a user message that starts with a slash reaches the model as text, never as a Claude Code command", async (t) => {
  const prompts: Block[][] = [];
  const fake = await installFakeClaudeCode((request) => {
    prompts.push(lastUser(request));
    return { text: "ok" };
  });
  t.after(fake.restore);
  const { session, close } = await piSession({ anthropic: TOKEN }, []);
  await session.prompt("/model claude-haiku-4-5");
  await close();
  assert.deepEqual(fake.calls[0]!.options.extraArgs, { "disable-slash-commands": null });
  assert.deepEqual(texts(prompts[0]!), ["\n/model claude-haiku-4-5"]);
});
