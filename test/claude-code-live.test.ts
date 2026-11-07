import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeCodeEnv } from "../src/model/claude-code.ts";
import { isClaudeSubscriptionToken } from "../src/model/claude-subscription.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

const TOKEN_FILE = process.env.CLAUDE_CODE_LIVE_TOKEN_FILE;
const MODEL_ID = process.env.CLAUDE_CODE_LIVE_MODEL ?? "claude-code/claude-sonnet-5";

async function accountEvidence(token: string): Promise<Record<string, unknown>> {
  const home = mkdtempSync(join(tmpdir(), "qm-claude-code-account-"));
  const session = query({
    prompt: (async function* () {})(),
    options: { env: claudeCodeEnv(token, home), cwd: home, tools: [], settingSources: [], strictMcpConfig: true },
  });
  try {
    const { subscriptionType, tokenSource, apiKeySource, apiProvider, organization } = await session.accountInfo();
    return { subscriptionType, tokenSource, apiKeySource, apiProvider, organizationPresent: Boolean(organization) };
  } finally {
    session.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test(
  "live: a QM tool turn and a resumed turn run on a Claude subscription through Claude Code",
  {
    skip: !TOKEN_FILE && "set CLAUDE_CODE_LIVE_TOKEN_FILE to an approved Claude subscription token file",
    timeout: 600_000,
  },
  async (t) => {
    assert.equal(statSync(TOKEN_FILE!).mode & 0o077, 0, "the token file must be private to its owner");
    const token = readFileSync(TOKEN_FILE!, "utf8").trim();
    assert.ok(isClaudeSubscriptionToken(token), "the file must hold a Claude subscription OAuth token");
    const realFetch = globalThis.fetch;
    const direct: string[] = [];
    t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (/anthropic\.com|claude\.ai|claude\.com/.test(new URL(url).hostname)) {
        direct.push(new URL(url).hostname);
        throw new Error("QM must not call Anthropic directly in this check");
      }
      return realFetch(input, init);
    });
    const evidence: string[] = [];
    const logError = console.error.bind(console);
    t.mock.method(console, "error", (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[claude-code]")) evidence.push(line.replaceAll(token, "<token>"));
      logError(...args);
    });

    t.diagnostic(`account: ${JSON.stringify(await accountEvidence(token))}`);
    const built = buildApp(testConfig({ anthropicApiKey: token, modelId: MODEL_ID }), { agent: undefined });
    const ask = (text: string) =>
      built.app.turn({
        surface: "slack",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: "claude-code-live" },
        text,
        origin: { kind: "human" },
        async: true,
      });
    built.runtime.start();
    try {
      const first = await built.runs.waitFor(
        (
          await ask(
            "Use your history tool to search this conversation for the word kiwi. Then reply with one line: TOOL-OK and the number of matches.",
          )
        ).runId!,
        300_000,
      );
      assert.equal(first.status, "done", JSON.stringify(first.result));
      const session = (await built.sessions.getByThread(first.sessionId))!;
      const second = await built.runs.waitFor(
        (
          await ask(
            "In one short sentence: which tool did you call in your previous turn, and what did you search for?",
          )
        ).runId!,
        300_000,
      );
      assert.equal(second.status, "done", JSON.stringify(second.result));
      const items = await built.sessions.getItems(session.id);
      const tools = items.filter((item) => item.kind === "ToolResult").map((item) => item.tool);
      const replies = items.filter((item) => item.kind === "AgentMessage" && item.text).map((item) => item.text);
      const records = (await built.sessions.listLlmRequests(session.id)).map((record) => ({
        model: record.model,
        turnSeq: record.turnSeq,
        step: record.step,
        usage: record.usage,
      }));
      t.diagnostic(`tools run by QM: ${JSON.stringify(tools)}`);
      t.diagnostic(`replies: ${JSON.stringify(replies)}`);
      t.diagnostic(`llm request records: ${JSON.stringify(records)}`);
      for (const line of evidence) t.diagnostic(line);
      assert.ok(tools.includes("history"), "the model called a QM tool and QM ran it");
      assert.match(replies.at(-1) ?? "", /kiwi/i, "the resumed turn saw the first turn's tool call");
      assert.deepEqual(direct, [], "every Anthropic request came from the Claude Code child, none from QM");
      assert.ok(
        evidence.some((line) => line.includes("subscription limit")),
        "Claude reported subscription limits",
      );
      assert.ok(
        !evidence.some((line) => /"isUsingOverage":true|"overageInUse":true/.test(line)),
        "no request drew on extra usage",
      );
    } finally {
      await built.runtime.stop();
    }
  },
);
