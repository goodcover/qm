import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createAgent } from "../src/agent/agent-run.ts";
import { createModelRoutes } from "../src/model/model-route.ts";
import { hashId } from "../src/util/crypto.ts";
import { anthropicMessage } from "./support/gateway-stream.ts";
import { historyThenAnswer, installFakeClaudeCode } from "./support/fake-claude-code.ts";

const SUBSCRIPTION_TOKEN = "sk-ant-oat01-personal-e2e";

function message(model: string, blocks: Array<Record<string, unknown> & { type: string }>, stop: string): Response {
  return new Response(anthropicMessage(model, blocks, stop, { input_tokens: 10, output_tokens: 1 }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

type Seen = Array<{ headers: Headers; body: Record<string, unknown> }>;

const ANTHROPIC_MIN_CLAUDE_CODE = "2.1.280";

function versionRefusal(userAgent: string): Response | undefined {
  const claimed = userAgent.split("claude-cli/")[1]?.split(" ")[0] ?? "0";
  if (claimed.localeCompare(ANTHROPIC_MIN_CLAUDE_CODE, undefined, { numeric: true }) >= 0) return undefined;
  const message = `Claude Code ${claimed} does not support this model; version ${ANTHROPIC_MIN_CLAUDE_CODE} or newer is required. Run 'claude update', or update the Claude desktop app, then try again.`;
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function fakeAnthropic(t: TestContext): Seen {
  const seen: Seen = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const raw = input instanceof Request ? await input.text() : String(init?.body ?? "{}");
    const body = JSON.parse(raw) as Record<string, unknown>;
    seen.push({ headers, body });
    const refused = headers.get("authorization") ? versionRefusal(headers.get("user-agent") ?? "") : undefined;
    if (refused) return refused;
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const system = JSON.stringify(body.system ?? "");
    const model = String(body.model);
    if (!system.includes("QM")) return message(model, [{ type: "text", text: "side call" }], "end_turn");
    const sawToolResult = JSON.stringify(messages).includes("tool_result");
    if (!sawToolResult) {
      const tools = (body.tools as Array<{ name: string }>) ?? [];
      const history = tools.find((tool) => tool.name.toLowerCase() === "history");
      assert.ok(history, `history tool offered: ${tools.map((tool) => tool.name).join(", ")}`);
      return message(
        model,
        [{ type: "tool_use", id: "toolu_e2e", name: history.name, input: { query: "anything" } }],
        "tool_use",
      );
    }
    return message(model, [{ type: "text", text: "pong from the Claude subscription" }], "end_turn");
  });
  return seen;
}

async function assertAnswered(built: ReturnType<typeof buildApp>, runId: string) {
  const finished = await built.runs.waitFor(runId, 20_000);
  assert.equal(finished.status, "done", JSON.stringify(finished.result));
  const session = await built.sessions.getByThread(finished.sessionId);
  const items = session ? await built.sessions.getItems(session.id) : [];
  assert.ok(
    items.some((item) => item.kind === "ToolResult" && item.tool === "history"),
    "the history tool ran",
  );
  assert.ok(
    items.some(
      (item) =>
        item.kind === "AgentMessage" &&
        item.variant === null &&
        /pong from the Claude subscription/.test(item.text ?? ""),
    ),
    JSON.stringify(items.map((item) => item.kind)),
  );
}

async function assertSubscriptionTurn(built: ReturnType<typeof buildApp>, seen: Seen, runId: string, token: string) {
  await assertAnswered(built, runId);
  const turnCalls = seen.filter((call) => JSON.stringify(call.body.system ?? "").includes("QM"));
  assert.equal(turnCalls.length, 2, "one tool-use step and one closing step");
  for (const call of turnCalls) {
    assert.equal(call.headers.get("authorization"), `Bearer ${token}`);
    assert.equal(call.headers.get("x-api-key"), null, "no API key header rides along");
    assert.match(call.headers.get("anthropic-beta") ?? "", /oauth-2025-04-20/);
    assert.match(JSON.stringify(call.body.system), /You are Claude Code/);
  }
}

async function claudeCodeServing(t: TestContext) {
  const fake = await installFakeClaudeCode(historyThenAnswer(() => "pong from the Claude subscription"));
  t.after(fake.restore);
  return fake;
}

test("a personal Claude subscription turn runs end to end on Pi with OAuth bearer auth, including a tool round trip", async (t) => {
  const seen = fakeAnthropic(t);

  const built = buildApp(testConfig({ anthropicApiKey: "sk-ant-api03-company" }), {
    agent: createAgent({
      routes: createModelRoutes({ resolveProviderKeys: async () => ({}) }),
      captureRequests: false,
    }),
  });
  await built.userModelCredentials.setOAuth("U1", "anthropic", {
    accessToken: SUBSCRIPTION_TOKEN,
    refreshToken: "refresh-e2e",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "claude-subscription-e2e" },
    text: "ping",
    origin: { kind: "human" },
    async: true,
  });
  built.runtime.start();
  try {
    await assertSubscriptionTurn(built, seen, submitted.runId!, SUBSCRIPTION_TOKEN);
    assert.ok(
      !seen.some((call) => (call.headers.get("x-api-key") ?? "").includes("company")),
      "no request in the personal turn used the company key",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a company Claude subscription credential serves company Claude turns through Claude Code beside a metered key and fails closed without it", async (t) => {
  const seen = fakeAnthropic(t);
  const fake = await claudeCodeServing(t);
  const ownerId = "claude-owner";
  const service = "claude-code";
  const envKey = "CLAUDE_CODE_OAUTH_TOKEN";
  const companyToken = "sk-ant-oat01-company-keychain-e2e";
  const credentialId = hashId([ownerId, service, `env:${envKey}`]);
  const built = buildApp(
    testConfig({
      anthropicApiKey: "sk-ant-api03-metered",
      claudeAuthCredential: credentialId,
      modelId: "claude-opus-5-5",
    }),
    { agent: undefined },
  );
  assert.equal((await built.keychain!.save({ ownerId, service, secret: companyToken, envKey })).id, credentialId);
  const turn = (threadRef: string) =>
    built.app.turn({
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef },
      text: "ping",
      origin: { kind: "human" },
      async: true,
    });
  const first = await turn("claude-company-keychain-e2e");
  built.runtime.start();
  try {
    await assertAnswered(built, first.runId!);
    assert.deepEqual(
      fake.calls.filter((call) => call.options.mcpServers).map((call) => call.options.model),
      ["claude-opus-5-5"],
      "one Claude Code query served the tool step and the answer with the selected model",
    );
    for (const call of fake.calls)
      assert.equal((call.options.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN, companyToken);
    assert.equal(seen.length, 0, "no company request went to the Anthropic API directly");
    await built.keychain!.remove(ownerId, credentialId);
    const turnQueries = () => fake.calls.filter((call) => call.options.mcpServers).length;
    const queries = turnQueries();
    const second = await turn("claude-company-keychain-missing-e2e");
    const deadline = Date.now() + 20_000;
    while (((await built.runs.get(second.runId!))?.errorAttempts ?? 0) === 0) {
      assert.ok(Date.now() < deadline, "the turn without its subscription credential fails");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.notEqual((await built.runs.get(second.runId!))?.status, "done");
    assert.equal(turnQueries(), queries, "no Claude Code turn starts without the subscription credential");
    assert.deepEqual(
      seen.filter((call) => call.headers.get("x-api-key")),
      [],
      "no request falls back to the metered key",
    );
  } finally {
    await built.runtime.stop();
  }
});
