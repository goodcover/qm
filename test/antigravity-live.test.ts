import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { credentialHandle } from "../src/credentials/keychain.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

const PROFILE = process.env.ANTIGRAVITY_LIVE_PROFILE;
const NEON = "antigravity/gemini-4-neon";
const USERS = ["U1", "U2"] as const;
type User = (typeof USERS)[number];
const OTHER: Record<User, User> = { U1: "U2", U2: "U1" };
const LOOKUP =
  "Use your history tool to search this conversation for the word locker. Reply with the locker code you found, or NONE.";
const marker = (prefix: string) => `${prefix}${randomBytes(4).toString("hex")}`;

function watchBoundaries() {
  let peak = 0;
  const timer = setInterval(() => {
    const children = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim().split(" ");
    const running = children.filter((pid) => {
      try {
        return pid !== "" && readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "bwrap";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return false;
      }
    });
    peak = Math.max(peak, running.length);
  }, 50);
  return () => {
    clearInterval(timer);
    return peak;
  };
}

test(
  "live: two company users share the instance Antigravity login in overlapping turns, each with only their own history, credentials and approvals",
  {
    skip: !PROFILE && "set ANTIGRAVITY_LIVE_PROFILE to a signed-in Antigravity profile directory",
    timeout: 900_000,
  },
  async (t) => {
    const built = buildApp(testConfig({ securityScreen: "off", antigravityProfile: PROFILE! }), { agent: undefined });
    const code = { U1: marker("kiwi"), U2: marker("plum") };
    const handle = {} as Record<User, string>;
    for (const user of USERS)
      handle[user] = credentialHandle(
        await built.keychain!.save({ ownerId: user, service: marker("ledger"), secret: "synthetic", envKey: "LEDGER" }),
      );
    const submit = (user: User, text: string, extra: Record<string, unknown> = {}) =>
      built.app.turn({
        surface: "web",
        actor: { externalId: user },
        conversation: { kind: "dm", threadRef: `web:${user}:neon-live` },
        text,
        origin: { kind: "human" },
        async: true,
        model: NEON,
        thinkingLevel: "low",
        ...extra,
      });
    const historyRuns = async (sessionId: string) =>
      (await built.sessions.getItems(sessionId)).filter(
        (item) => item.kind === "ToolResult" && item.tool === "history" && !item.body.blocked,
      ).length;
    const settle = async (submitted: { runId?: string }) => {
      const run = await built.runs.waitFor(submitted.runId!, 300_000);
      const session = (await built.sessions.getByThread(run.sessionId))!;
      const items = (await built.sessions.getItems(session.id)).filter((item) => item.turnId === run.id);
      const records = (await built.sessions.listLlmRequests(session.id)).filter((r) => r.model === NEON);
      return {
        run,
        results: items.filter((item) => item.kind === "ToolResult"),
        calls: items.filter((item) => item.kind === "ToolCall"),
        reply: items.findLast((item) => item.kind === "AgentMessage")?.text ?? "",
        system: records.map((record) => (record.promptEnvelope as { system?: string }).system ?? "").join("\n"),
      };
    };
    const together = async (texts: Record<User, string>) => {
      const stop = watchBoundaries();
      const submitted = await Promise.all(USERS.map((user) => submit(user, texts[user])));
      const [u1, u2] = await Promise.all(submitted.map(settle));
      const peak = stop();
      const runs = [u1!.run, u2!.run];
      const overlapMs =
        Math.min(...runs.map((run) => run.finishedAt!)) - Math.max(...runs.map((run) => run.startedAt!));
      t.diagnostic(`observed overlap ${overlapMs}ms, peak Antigravity boundaries ${peak}`);
      assert.ok(overlapMs > 0 && peak >= 2, "both turns ran on the shared login at the same time");
      for (const run of runs) assert.equal(run.status, "done", JSON.stringify(run.result));
      return { U1: u1!, U2: u2! };
    };
    built.runtime.start();
    try {
      const tried = await together({
        U1: `My locker code is ${code.U1}. Call execute with command "true" and credentials ["${handle.U2}"], then reply with its result.`,
        U2: `My locker code is ${code.U2}. Call execute with command "true" and credentials ["${handle.U1}"], then reply with its result.`,
      });
      for (const user of USERS) {
        const turn = tried[user];
        assert.ok(turn.system.includes(handle[user]), `${user}'s own credential is offered to ${user}`);
        assert.ok(!turn.system.includes(handle[OTHER[user]]), `${user} is never offered the other user's credential`);
        const executes = turn.results.filter((item) => item.tool === "execute");
        assert.ok(executes.length, `${user}'s turn called execute`);
        for (const item of executes)
          assert.ok(JSON.stringify(item).includes("credential handle is not available on this turn"));
        for (const call of turn.calls.filter((item) => item.tool === "execute"))
          assert.ok(JSON.stringify(call.body).includes('"true"'), "only the harmless fixture command was requested");
      }

      const looked = await together({ U1: LOOKUP, U2: LOOKUP });
      for (const user of USERS) {
        assert.ok(
          looked[user].results.some((item) => item.tool === "history"),
          `${user} ran QM's history tool`,
        );
        assert.ok(looked[user].reply.includes(code[user]), `${user} reads ${user}'s own history`);
        assert.ok(!looked[user].reply.includes(code[OTHER[user]]), `${user} never sees the other user's code`);
      }

      await built.config.setSecurityPosture("personal:U1", "strict");
      const paused = await built.runs.waitFor((await submit("U1", LOOKUP)).runId!, 300_000);
      const requestId = (paused.result as { pendingApprovals?: Array<{ requestId: string }> } | undefined)
        ?.pendingApprovals?.[0]?.requestId;
      assert.ok(requestId, JSON.stringify(paused.result));
      const u1Session = (await built.sessions.getByThread(paused.sessionId))!.id;
      const before = await historyRuns(u1Session);
      const foreign = await submit("U2", "approve", { approval: { requestId, approved: true } });
      const refusal = foreign.runId ? (await built.runs.waitFor(foreign.runId, 300_000)).result : foreign;
      t.diagnostic(`U2 approving U1's call: ${JSON.stringify(refusal)}`);
      assert.equal((refusal as { status?: string }).status, "refused", JSON.stringify(refusal));
      assert.equal(await historyRuns(u1Session), before, "U2's attempt ran nothing in U1's conversation");
      const approved = await settle(await submit("U1", "approve", { approval: { requestId, approved: true } }));
      assert.equal(approved.run.status, "done", JSON.stringify(approved.run.result));
      assert.equal(await historyRuns(u1Session), before + 1, "U1's approval ran exactly U1's call");
      assert.ok(approved.reply.includes(code.U1) && !approved.reply.includes(code.U2));
    } finally {
      await built.runtime.stop();
    }
  },
);
