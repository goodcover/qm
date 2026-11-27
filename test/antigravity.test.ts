import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { Type } from "typebox";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { createAntigravityConnection } from "../src/model/antigravity.ts";
import { processExit } from "../src/model/antigravity-boundary.ts";
import { resolveModel } from "../src/model/pi-models.ts";

const model = resolveModel("antigravity/gemini-4-neon")!;
const tools = [{ name: "lookup", description: "Look up one record.", parameters: Type.Object({ key: Type.String() }) }];

function fakeAntigravity(script: string, pids: number[] = []) {
  return () => {
    const child = spawn(process.execPath, ["test/support/fake-antigravity.ts", script]);
    pids.push(child.pid!);
    return { child, exited: processExit(child, () => undefined) };
  };
}

function ask(connection: ReturnType<typeof createAntigravityConnection>, messages: Message[], signal?: AbortSignal) {
  return connection.streamSimple(model, { systemPrompt: "You are QM.", messages, tools }, { apiKey: "/p", signal });
}

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

const user: Message = { role: "user", content: "go", timestamp: 0 };

test("an Antigravity tool call is handed to QM and QM's result reaches Antigravity's MCP request", async () => {
  const connection = createAntigravityConnection(fakeAntigravity("tool"));
  const first = await ask(connection, [user]).result();
  assert.equal(first.stopReason, "toolUse", first.errorMessage);
  const call = first.content.find((block): block is ToolCall => block.type === "toolCall")!;
  assert.deepEqual([call.name, call.arguments], ["lookup", { key: "kiwi" }]);
  const result: Message = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: "lookup",
    content: [{ type: "text", text: "record kiwi" }],
    isError: false,
    timestamp: 0,
  };
  const second = await ask(connection, [user, first, result]).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.deepEqual(second.content, [{ type: "text", text: " saw record kiwi" }]);
  assert.equal(second.usage.input, 40);
  await connection.close();
});

test("Antigravity fails closed on a tool QM does not serve, reports its exit, and refuses a turn without the instance login", async () => {
  const pids: number[] = [];
  const connection = createAntigravityConnection(fakeAntigravity("foreign", pids));
  const failed = await ask(connection, [user]).result();
  assert.equal(failed.stopReason, "error");
  assert.match(failed.errorMessage!, /read_file, which is not a tool QM serves/);
  await connection.close();
  assert.ok(gone(pids[0]!), "QM killed the Antigravity process");

  const died = await ask(createAntigravityConnection(fakeAntigravity("die")), [user]).result();
  assert.match(died.errorMessage!, /Antigravity exited with code 7 before the turn finished/);

  const refused = await createAntigravityConnection(fakeAntigravity("tool"))
    .streamSimple(model, { messages: [user] })
    .result();
  assert.match(refused.errorMessage!, /needs this instance's Antigravity login/);
});

test("aborting the run kills Antigravity", async () => {
  const pids: number[] = [];
  const connection = createAntigravityConnection(fakeAntigravity("hang", pids));
  const controller = new AbortController();
  const stream = ask(connection, [user], controller.signal);
  for await (const event of stream) if (event.type === "text_delta") controller.abort();
  const aborted: AssistantMessage = await stream.result();
  assert.equal(aborted.stopReason, "aborted");
  await connection.close();
  assert.ok(gone(pids[0]!), "no Antigravity process outlives the aborted run");
});
