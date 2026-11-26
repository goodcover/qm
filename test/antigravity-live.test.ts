import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

const MODEL_ID = "antigravity/gemini-4-neon";

test(
  "live: the owner's personal turns run QM's history tool through Antigravity and nobody else reaches the login",
  {
    skip:
      !process.env.ANTIGRAVITY_LIVE &&
      "set ANTIGRAVITY_LIVE=1 to run against this user's signed-in Antigravity profile",
    timeout: 600_000,
  },
  async (t) => {
    const built = buildApp(testConfig({ securityScreen: "off", antigravityOwner: "U1" }), { agent: undefined });
    await built.config.setPersonalModelAuth("U1", true);
    await built.config.setPersonalModelAuth("U2", true);
    const submit = (user: string, text: string) =>
      built.app.turn({
        surface: "web",
        actor: { externalId: user },
        conversation: { kind: "dm", threadRef: `web:${user}:antigravity-live` },
        text,
        origin: { kind: "human" },
        async: true,
        model: MODEL_ID,
        thinkingLevel: "low",
      });
    const ask = async (text: string) => built.runs.waitFor((await submit("U1", text)).runId!, 300_000);
    built.runtime.start();
    try {
      const first = await ask(
        "Use your history tool to search this conversation for the word kiwi. Then reply with one line: TOOL-OK and the number of matches.",
      );
      assert.equal(first.status, "done", JSON.stringify(first.result));
      const second = await ask(
        "In one short sentence: which tool did you call in your previous turn, and what did you search for?",
      );
      assert.equal(second.status, "done", JSON.stringify(second.result));
      const session = (await built.sessions.getByThread(first.sessionId))!;
      const items = await built.sessions.getItems(session.id);
      const tools = items.filter((item) => item.kind === "ToolResult").map((item) => item.tool);
      const replies = items.filter((item) => item.kind === "AgentMessage" && item.text).map((item) => item.text);
      const records = (await built.sessions.listLlmRequests(session.id)).map((record) => ({
        model: record.model,
        turnSeq: record.turnSeq,
        usage: record.usage,
      }));
      t.diagnostic(`tools run by QM: ${JSON.stringify(tools)}`);
      t.diagnostic(`replies: ${JSON.stringify(replies)}`);
      t.diagnostic(`llm request records: ${JSON.stringify(records)}`);
      assert.ok(tools.includes("history"), "the model called a QM tool and QM ran it");
      assert.ok(
        (replies.at(-1) ?? "").toLowerCase().includes("kiwi"),
        "the second turn saw the first turn's tool call",
      );
      assert.ok(
        records.some((record) => record.model === MODEL_ID && (record.usage?.input ?? 0) > 0),
        "Antigravity reported usage for the turn",
      );

      assert.deepEqual(await submit("U2", "Reply OK."), {
        status: "refused",
        reason: "Your connected AI account cannot serve this model.",
      });
    } finally {
      await built.runtime.stop();
    }
  },
);
