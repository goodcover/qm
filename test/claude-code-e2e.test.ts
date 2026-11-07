import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { answered, installFakeClaudeCode, type FakeRequest } from "./support/fake-claude-code.ts";
import { CLAUDE_CODE_TEST_MODEL as MODEL_ID } from "./support/claude-code-session.ts";

const COMPANY_TOKEN = "sk-ant-oat01-company-claude-code-e2e";

function historyThenAnswer(requests: FakeRequest[]) {
  return (request: FakeRequest) => {
    if (!request.tools.length) return { text: "side request" };
    requests.push(request);
    if (answered(request)) return { text: `pong ${requests.length}`, usage: { input: 40, output: 8 } };
    return { tools: [{ id: `toolu_${requests.length}`, name: "mcp__qm__history", input: { query: "anything" } }] };
  };
}

function turn(built: ReturnType<typeof buildApp>, threadRef: string, extra: Record<string, unknown> = {}) {
  return built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef },
    text: "ping",
    origin: { kind: "human" },
    async: true,
    ...extra,
  });
}

test("a QM turn on claude-code serves QM's real prompt and tools, records usage, and resumes from Postgres history", async (t) => {
  const requests: FakeRequest[] = [];
  const fake = await installFakeClaudeCode(historyThenAnswer(requests));
  t.after(fake.restore);
  const built = buildApp(testConfig({ anthropicApiKey: COMPANY_TOKEN, modelId: MODEL_ID }), { agent: undefined });
  const first = await turn(built, "claude-code-e2e");
  built.runtime.start();
  try {
    const done = await built.runs.waitFor(first.runId!, 20_000);
    assert.equal(done.status, "done", JSON.stringify(done.result));
    const session = await built.sessions.getByThread(done.sessionId);
    const items = await built.sessions.getItems(session!.id);
    assert.ok(
      items.some((item) => item.kind === "ToolResult" && item.tool === "history"),
      "QM ran its own history tool",
    );
    assert.ok(
      items.some((item) => item.kind === "AgentMessage" && item.text === "pong 2"),
      JSON.stringify(items.map((item) => [item.kind, item.text?.slice(0, 80)])),
    );

    const call = fake.calls.find((c) => c.options.mcpServers)!;
    assert.ok(requests[0]!.tools.includes("mcp__qm__history") && requests[0]!.tools.includes("mcp__qm__execute"));
    assert.ok(
      requests[0]!.tools.every((name) => name.startsWith("mcp__qm__")),
      "only QM's tool catalog",
    );
    const env = call.options.env as Record<string, string>;
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, COMPANY_TOKEN);
    assert.equal(env.CLAUDE_CODE_PROMPT_CACHE_TTL, "1h", "QM's long cache retention for turns reaches Claude Code");
    assert.ok(!call.options.resume, "the first turn has no prior history");

    const records = await built.sessions.listLlmRequests(session!.id);
    const turnRecords = records.filter((record) => record.model === MODEL_ID && record.turnSeq !== null);
    assert.equal(turnRecords.length, 2, "both model calls of the turn are recorded");
    assert.equal(turnRecords.at(-1)?.usage?.input, 40);
    assert.equal(
      (turnRecords[0]!.promptEnvelope as { system?: string }).system,
      call.options.systemPrompt,
      "Claude Code received exactly the system prompt QM recorded for the request",
    );

    const second = await turn(built, "claude-code-e2e", { text: "again" });
    const again = await built.runs.waitFor(second.runId!, 20_000);
    assert.equal(again.status, "done", JSON.stringify(again.result));
    const resumed = fake.calls.find((c, index) => index > 0 && c.options.resume);
    assert.ok(resumed, "the second turn resumes an imported transcript");
    const blocks = resumed.history.flatMap((turn) => turn.content);
    assert.ok(blocks.some((block) => block.type === "tool_use" && block.name === "mcp__qm__history"));
    assert.ok(blocks.some((block) => block.type === "tool_result"));
    assert.ok(blocks.some((block) => block.type === "text" && block.text === "pong 2"));
  } finally {
    await built.runtime.stop();
  }
});

test("under the strict posture a Claude Code tool call pauses for QM approval and resumes after it", async (t) => {
  const requests: FakeRequest[] = [];
  const fake = await installFakeClaudeCode(historyThenAnswer(requests));
  t.after(fake.restore);
  const built = buildApp(testConfig({ anthropicApiKey: COMPANY_TOKEN, modelId: MODEL_ID }), { agent: undefined });
  await built.config.setSecurityPosture("personal:U1", "strict");
  const first = await turn(built, "claude-code-approval-e2e");
  built.runtime.start();
  try {
    const paused = await built.runs.waitFor(first.runId!, 20_000);
    const pending = (paused.result as { pendingApprovals?: Array<{ requestId: string }> } | undefined)
      ?.pendingApprovals;
    assert.ok(pending?.length, JSON.stringify(paused.result));
    const session = await built.sessions.getByThread(paused.sessionId);
    const before = await built.sessions.getItems(session!.id);
    const gated = before.filter((item) => item.kind === "ToolResult" && item.tool === "history");
    assert.deepEqual(
      gated.map((item) => item.body.blocked),
      ["needs_approval"],
      "the only history result before approval is QM's approval boundary",
    );
    assert.equal(fake.calls[0]!.closed, true, "the parked Claude Code query ended with the turn");

    const approved = await turn(built, "claude-code-approval-e2e", {
      approval: { requestId: pending[0]!.requestId, approved: true },
    });
    const done = await built.runs.waitFor(approved.runId!, 20_000);
    assert.equal(done.status, "done", JSON.stringify(done.result));
    const items = await built.sessions.getItems(session!.id);
    const ran = items.filter((item) => item.kind === "ToolResult" && item.tool === "history" && !item.body.blocked);
    assert.equal(ran.length, 1, "the approved call ran exactly once, in QM");
    assert.ok(items.some((item) => item.kind === "AgentMessage" && item.text?.startsWith("pong")));
    const resumed = fake.calls.filter((c) => c.options.mcpServers).at(-1)!;
    assert.ok(resumed.options.resume, "the approved turn resumes from imported history");
  } finally {
    await built.runtime.stop();
  }
});
