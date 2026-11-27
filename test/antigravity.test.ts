import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { Type } from "typebox";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { createAntigravityConnection } from "../src/model/antigravity.ts";
import { trackProcess } from "../src/model/harness.ts";
import { providerTurnError } from "../src/model/provider-error.ts";
import { processAlive } from "./support/fake-claude-code.ts";
import { resolveModel } from "../src/model/pi-models.ts";

const model = resolveModel("antigravity/gemini-4-neon")!;
const tools = [{ name: "lookup", description: "Look up one record.", parameters: Type.Object({ key: Type.String() }) }];

function fakeAntigravity(script: string, children: ChildProcess[] = []) {
  return () => {
    const child = spawn(process.execPath, ["test/support/fake-antigravity.ts", script]);
    children.push(child);
    return { child, exited: trackProcess("fake-antigravity", child) };
  };
}

function ask(connection: ReturnType<typeof createAntigravityConnection>, messages: Message[], signal?: AbortSignal) {
  return connection.streamSimple(model, { systemPrompt: "You are QM.", messages, tools }, { apiKey: "/p", signal });
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
  const children: ChildProcess[] = [];
  const connection = createAntigravityConnection(fakeAntigravity("foreign", children));
  const failed = await ask(connection, [user]).result();
  assert.equal(failed.stopReason, "error");
  assert.match(failed.errorMessage!, /read_file, which is not a tool QM serves/);
  await connection.close();
  assert.ok(!processAlive(children[0]), "QM killed the Antigravity process");

  const died = await ask(createAntigravityConnection(fakeAntigravity("die")), [user]).result();
  assert.match(died.errorMessage!, /Antigravity exited with code 7 before the turn finished/);

  const refused = await createAntigravityConnection(fakeAntigravity("tool"))
    .streamSimple(model, { messages: [user] })
    .result();
  assert.match(refused.errorMessage!, /needs this instance's Antigravity login/);
});

test("Antigravity's own stops reach QM with their cause and the category QM routes on", async () => {
  const outcome = async (launch: Parameters<typeof createAntigravityConnection>[0]) => {
    const failed = await ask(createAntigravityConnection(launch), [user]).result();
    return { stopReason: failed.stopReason, message: failed.errorMessage, code: providerTurnError(failed).code };
  };
  assert.deepEqual(await outcome(fakeAntigravity("refusal")), {
    stopReason: "error",
    message: "The model declined to continue (refusal)",
    code: "refusal",
  });
  assert.equal((await outcome(fakeAntigravity("cancelled"))).stopReason, "error");
  assert.ok((await outcome(fakeAntigravity("quota"))).message?.includes("daily quota reached"));
  const unlaunchable = await outcome(() => {
    throw new Error("the profile directory is missing");
  });
  assert.equal(unlaunchable.code, "model_unavailable");
  assert.ok(unlaunchable.message?.includes("the profile directory is missing"));
});

test("aborting the run kills Antigravity", async () => {
  const children: ChildProcess[] = [];
  const connection = createAntigravityConnection(fakeAntigravity("hang", children));
  const controller = new AbortController();
  const stream = ask(connection, [user], controller.signal);
  for await (const event of stream) if (event.type === "text_delta") controller.abort();
  const aborted: AssistantMessage = await stream.result();
  assert.equal(aborted.stopReason, "aborted");
  await connection.close();
  assert.ok(!processAlive(children[0]), "no Antigravity process outlives the aborted run");
});
