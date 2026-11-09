import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { sleep } from "../../src/util/async.ts";

export type Block = Record<string, unknown> & { type: string };
export interface Turn {
  role: "user" | "assistant";
  content: Block[];
}

export interface FakeRequest {
  messages: Turn[];
  tools: string[];
}

export interface FakeReply {
  text?: string;
  thinking?: { text: string; signature: string };
  tools?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  callOrder?: "reverse";
  error?: { kind: string; text: string; status?: number };
  rateLimit?: Record<string, unknown>;
  refusal?: boolean;
  endWithoutResult?: boolean;
  usage?: { input: number; output: number; cacheRead?: number };
}

export interface FakeCall {
  options: Options;
  history: Turn[];
  mcpCalls: Array<{ name: string; id: string; result: unknown }>;
  listedTools: Array<{ name: string; description?: string; inputSchema: unknown }>;
  child?: ChildProcess;
  closed: boolean;
  initTools?: string[];
  apiKeySource?: string;
  initPlugins?: Array<{ name: string; path: string }>;
  initSkills?: string[];
  hookEvent?: string;
  managedSettings?: Record<string, unknown>;
}

type Tweak = Partial<
  Pick<FakeCall, "initTools" | "apiKeySource" | "initPlugins" | "initSkills" | "hookEvent" | "managedSettings">
>;

const BUILTIN_PLUGINS = [{ name: "cc-plugin-agents-md", path: "builtin" }];

type Model = (request: FakeRequest) => FakeReply | Promise<FakeReply>;

function stopReason(reply: FakeReply): string {
  if (reply.refusal) return "refusal";
  return reply.tools?.length ? "tool_use" : "end_turn";
}

function streamEvents(id: string, reply: FakeReply): SDKMessage[] {
  const events: Array<Record<string, unknown>> = [];
  const usage = reply.usage ?? { input: 10, output: 5 };
  events.push({
    type: "message_start",
    message: {
      id,
      usage: {
        input_tokens: usage.input,
        output_tokens: 1,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
  let index = 0;
  if (reply.thinking) {
    events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
    events.push({
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking: reply.thinking.text },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta: { type: "signature_delta", signature: reply.thinking.signature },
    });
    events.push({ type: "content_block_stop", index });
    index++;
  }
  if (reply.text !== undefined) {
    events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    for (let at = 0; at < Math.max(reply.text.length, 1); at += 7)
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: reply.text.slice(at, at + 7) },
      });
    events.push({ type: "content_block_stop", index });
    index++;
  }
  for (const tool of reply.tools ?? []) {
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
    });
    const json = JSON.stringify(tool.input);
    events.push({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: json.slice(0, 3) },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: json.slice(3) },
    });
    events.push({ type: "content_block_stop", index });
    index++;
  }
  events.push({
    type: "message_delta",
    delta: { stop_reason: stopReason(reply) },
    usage: { output_tokens: usage.output },
  });
  events.push({ type: "message_stop" });
  return events.map((event) => ({
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "fake",
  })) as unknown as SDKMessage[];
}

function assistantContent(reply: FakeReply): Block[] {
  return [
    ...(reply.thinking
      ? [{ type: "thinking", thinking: reply.thinking.text, signature: reply.thinking.signature }]
      : []),
    ...(reply.text !== undefined ? [{ type: "text", text: reply.text }] : []),
    ...(reply.tools ?? []).map((tool) => ({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input })),
  ];
}

function readTranscript(options: Options): Array<Record<string, unknown>> {
  if (!options.resume) return [];
  const projects = join(String(options.env?.CLAUDE_CONFIG_DIR), "projects");
  for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
    const file = join(projects, dir, `${options.resume}.jsonl`);
    if (!existsSync(file)) continue;
    const records = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return records;
  }
  throw new Error(`no transcript for resumed session ${options.resume}`);
}

function historyFrom(records: Array<Record<string, unknown>>): Turn[] {
  return records
    .filter((record) => record.type === "user" || record.type === "assistant")
    .map((record) => {
      const message = record.message as { role: "user" | "assistant"; content: string | Block[] };
      return {
        role: message.role,
        content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
      };
    });
}

export function fakeClaudeCode(model: Model, tweak: Tweak = {}) {
  const calls: FakeCall[] = [];

  function query({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) {
    const call: FakeCall = {
      options,
      history: historyFrom(readTranscript(options)),
      mcpCalls: [],
      listedTools: [],
      closed: false,
      ...tweak,
    };
    calls.push(call);
    const inbox: SDKUserMessage[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    void (async () => {
      for await (const message of prompt) {
        inbox.push(message);
        wake?.();
      }
      ended = true;
      wake?.();
    })();
    const next = async (): Promise<SDKUserMessage | undefined> => {
      while (!inbox.length && !ended) await new Promise<void>((resolve) => (wake = resolve));
      return inbox.shift();
    };
    const drain = (): SDKUserMessage[] => inbox.splice(0);

    const client = new Client({ name: "fake-claude-code", version: "0" });

    async function* run(): AsyncGenerator<SDKMessage> {
      call.child = options.spawnClaudeCodeProcess!({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: options.cwd!,
        env: options.env as Record<string, string>,
        signal: options.abortController!.signal,
      }) as unknown as ChildProcess;
      const server = (options.mcpServers?.qm as { instance?: McpServer } | undefined)?.instance;
      if (server) {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        await client.connect(clientSide);
        call.listedTools = (await client.listTools()).tools;
      }
      const offered = call.listedTools.map((tool) => `mcp__qm__${tool.name}`);
      if (call.hookEvent)
        yield {
          type: "system",
          subtype: "hook_started",
          hook_id: "hook-1",
          hook_name: `${call.hookEvent}:startup`,
          hook_event: call.hookEvent,
          uuid: randomUUID(),
          session_id: "fake",
        } as unknown as SDKMessage;
      yield {
        type: "system",
        subtype: "init",
        tools: call.initTools ?? offered,
        apiKeySource: call.apiKeySource ?? "none",
        plugins: call.initPlugins ?? BUILTIN_PLUGINS,
        skills: call.initSkills ?? [],
        mcp_servers: server ? [{ name: "qm", status: "connected" }] : [],
        model: options.model,
        cwd: options.cwd,
        session_id: "fake",
      } as unknown as SDKMessage;
      const conversation: Turn[] = [...call.history];
      const first = await next();
      if (!first) return;
      conversation.push({ role: "user", content: first.message.content as unknown as Block[] });
      for (;;) {
        const reply = await model({ messages: conversation, tools: offered });
        if (reply.rateLimit)
          yield {
            type: "rate_limit_event",
            rate_limit_info: reply.rateLimit,
            uuid: randomUUID(),
            session_id: "fake",
          } as unknown as SDKMessage;
        if (reply.endWithoutResult) {
          await stopChild("SIGKILL");
          throw new Error("Claude Code process terminated by signal SIGKILL");
        }
        if (reply.error) {
          yield {
            type: "assistant",
            message: { id: randomUUID(), model: "<synthetic>", content: [{ type: "text", text: reply.error.text }] },
            parent_tool_use_id: null,
            error: reply.error.kind,
            uuid: randomUUID(),
            session_id: "fake",
          } as unknown as SDKMessage;
          yield {
            type: "result",
            subtype: "success",
            is_error: true,
            ...(reply.error.status ? { api_error_status: reply.error.status } : {}),
            result: reply.error.text,
          } as unknown as SDKMessage;
          return;
        }
        const id = `msg_${randomUUID()}`;
        yield* streamEvents(id, reply);
        const content = assistantContent(reply);
        yield {
          type: "assistant",
          message: { id, model: options.model, content },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: "fake",
        } as unknown as SDKMessage;
        conversation.push({ role: "assistant", content });
        const served = (reply.tools ?? []).filter((tool) => offered.includes(tool.name));
        if (!reply.tools?.length) {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: reply.text ?? "",
          } as unknown as SDKMessage;
          return;
        }
        const order = reply.callOrder === "reverse" ? [...served].reverse() : served;
        const results = new Map<string, unknown>();
        await Promise.all(
          order.map(async (tool) => {
            const result = await client.callTool({
              name: tool.name.slice("mcp__qm__".length),
              arguments: tool.input,
              _meta: { "claudecode/toolUseId": tool.id },
            });
            call.mcpCalls.push({ name: tool.name, id: tool.id, result });
            results.set(tool.id, result);
          }),
        );
        const toolResults: Block[] = (reply.tools ?? []).map((tool) => {
          const result = results.get(tool.id) as { content?: unknown; isError?: boolean } | undefined;
          return result
            ? { type: "tool_result", tool_use_id: tool.id, content: result.content, is_error: result.isError === true }
            : { type: "tool_result", tool_use_id: tool.id, content: "No such tool available", is_error: true };
        });
        const steers = drain().flatMap((message) => message.message.content as unknown as Block[]);
        conversation.push({ role: "user", content: [...toolResults, ...steers] });
      }
    }

    async function stopChild(signal: NodeJS.Signals): Promise<void> {
      const child = call.child;
      if (!processAlive(child)) return;
      const exited = new Promise((resolve) => child!.once("exit", resolve));
      child!.kill(signal);
      await exited;
    }

    const generator = run();
    const finish = generator.return.bind(generator);
    return Object.assign(generator, {
      async return(value: undefined): Promise<IteratorResult<SDKMessage, void>> {
        call.closed = true;
        await stopChild("SIGTERM");
        await client.close();
        void finish(value);
        return { done: true, value };
      },
      async interrupt() {},
      async getSettings() {
        return {
          sources: [
            { source: "flagSettings", settings: options.settings },
            ...(call.managedSettings ? [{ source: "policySettings", settings: call.managedSettings }] : []),
          ],
        };
      },
    });
  }

  return { calls, query };
}

export async function installFakeClaudeCode(model: Model, tweak: Tweak = {}) {
  const fake = fakeClaudeCode(model, tweak);
  const real = await import("@anthropic-ai/claude-agent-sdk");
  const mocked = mock.module("@anthropic-ai/claude-agent-sdk", {
    namedExports: { ...real, query: fake.query },
  });
  return {
    ...fake,
    async restore() {
      mocked.restore();
      const left = await leftovers(fake.calls);
      if (left.length) throw new Error(`Claude Code queries were not cleaned up: ${left.join("; ")}`);
    },
  };
}

export function historyThenAnswer(answer: (requests: number) => string, sink: FakeRequest[] = []): Model {
  return (request) => {
    if (!request.tools.length) return { text: "side request" };
    sink.push(request);
    if (answered(request)) return { text: answer(sink.length), usage: { input: 40, output: 8 } };
    return { tools: [{ id: `toolu_${sink.length}`, name: "mcp__qm__history", input: { query: "anything" } }] };
  };
}

export function lastUser(request: { messages: ReadonlyArray<{ role: string; content: Block[] }> }): Block[] {
  return request.messages.findLast((message) => message.role === "user")?.content ?? [];
}

export function answered(request: Pick<FakeRequest, "messages">): boolean {
  return lastUser(request).some((block) => block.type === "tool_result");
}

async function leftovers(calls: readonly FakeCall[]): Promise<string[]> {
  const remaining = () =>
    calls.flatMap((call, index) => {
      const dir = String(call.options.env?.CLAUDE_CONFIG_DIR);
      return [
        ...(processAlive(call.child) ? [`query ${index}: process still running`] : []),
        ...(existsSync(dir) ? [`query ${index}: ${dir} still exists`] : []),
      ];
    });
  for (let i = 0; i < 100 && remaining().length; i++) await sleep(20);
  return remaining();
}

export function processAlive(child: ChildProcess | undefined): boolean {
  if (!child?.pid) return false;
  try {
    process.kill(child.pid, 0);
    return child.exitCode === null && child.signalCode === null;
  } catch {
    return false;
  }
}
