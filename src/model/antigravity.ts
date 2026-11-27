import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Usage as PromptUsage } from "@agentclientprotocol/sdk/unstable";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import { constantTimeEqual } from "../util/crypto.ts";
import { asError, errMessage, swallow } from "../util/errors.ts";
import {
  ANTIGRAVITY_MCP_SERVER,
  ANTIGRAVITY_WORKSPACE,
  launchAntigravity,
  type AntigravityProcess,
} from "./antigravity-boundary.ts";
import {
  answersToolCalls,
  closeOnce,
  failStep,
  finishStep,
  HarnessFailure,
  harnessOutput,
  harnessSlot,
  mcpResult,
  qmToolServer,
  refuseUnsent,
  RESUMED_AT_TOOL_RESULTS,
  startStep,
  type HarnessStep,
  type ServedTool,
} from "./harness.ts";
import { antigravityServedModelId } from "./pi-models.ts";
import { zeroUsage } from "./model-runtime.ts";

const AGY_TOOL_PREFIX = `mcp_${ANTIGRAVITY_MCP_SERVER}_`;
const ALWAYS_LOAD = "antigravity/alwaysLoad";
const SENT_FIELDS = new Set(["model", "thought_level", "system", "messages", "tools"]);
const AUTH_REQUIRED = acp.RequestError.authRequired().code;

interface AntigravityRequest {
  model: string;
  thought_level?: string;
  system: string;
  messages: [{ role: "user"; content: acp.ContentBlock[] }];
  tools: ServedTool[];
}

interface Call {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  settle: (result: CallToolResult) => void;
}

interface Step extends HarnessStep {
  open?: "text" | "thinking";
}

interface Live {
  model: Model<Api>;
  proc: AntigravityProcess;
  http: Server;
  served: Set<string>;
  started: Set<string>;
  connection?: acp.ClientConnection;
  sessionId?: string;
  prompts: number;
  prompting?: Promise<void>;
  unbilled: Usage;
  dropped?: unknown;
  step?: Step;
  backlog: Array<{ kind: "text" | "thinking"; text: string }>;
  queued: Call[];
  awaiting: Map<string, Call>;
  handedOut: string[];
  failure?: Error;
  done: boolean;
  closed: boolean;
  closing?: Promise<void>;
}

function closeBlock(step: Step): void {
  const contentIndex = step.output.content.length - 1;
  const block = step.output.content[contentIndex];
  if (step.open === "text" && block?.type === "text")
    step.stream.push({ type: "text_end", contentIndex, content: block.text, partial: step.output });
  if (step.open === "thinking" && block?.type === "thinking")
    step.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: step.output });
  step.open = undefined;
}

function append(step: Step, kind: "text" | "thinking", delta: string): void {
  startStep(step);
  const partial = step.output;
  if (step.open !== kind) {
    closeBlock(step);
    partial.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
    step.open = kind;
    const contentIndex = partial.content.length - 1;
    step.stream.push(
      kind === "text"
        ? { type: "text_start", contentIndex, partial }
        : { type: "thinking_start", contentIndex, partial },
    );
  }
  const contentIndex = partial.content.length - 1;
  const block = partial.content[contentIndex]!;
  if (block.type === "text") {
    block.text += delta;
    step.stream.push({ type: "text_delta", contentIndex, delta, partial });
  } else if (block.type === "thinking") {
    block.thinking += delta;
    step.stream.push({ type: "thinking_delta", contentIndex, delta, partial });
  }
}

function endStep(live: Live, reason: "stop" | "length" | "toolUse"): void {
  const step = live.step;
  if (!step) return;
  live.step = undefined;
  startStep(step);
  closeBlock(step);
  finishStep(step, reason);
}

function abandon(step: Step, error: Error, aborted: boolean): void {
  closeBlock(step);
  failStep(step, error, aborted);
}

function handOut(live: Live): void {
  const step = live.step;
  if (!step || !live.queued.length) return;
  startStep(step);
  closeBlock(step);
  live.handedOut = [];
  for (const call of live.queued.splice(0)) {
    const toolCall: ToolCall = { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments };
    step.output.content.push(toolCall);
    const contentIndex = step.output.content.length - 1;
    step.stream.push({ type: "toolcall_start", contentIndex, partial: step.output });
    step.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: step.output });
    live.awaiting.set(call.id, call);
    live.handedOut.push(call.id);
  }
  endStep(live, "toolUse");
}

function settleAll(live: Live, reason: string): void {
  const result: CallToolResult = { content: [{ type: "text", text: reason }], isError: true };
  for (const call of [...live.queued.splice(0), ...live.awaiting.values()]) call.settle(result);
  live.awaiting.clear();
}

async function teardown(live: Live, reason: string): Promise<void> {
  live.closed = true;
  const step = live.step;
  live.step = undefined;
  if (step) abandon(step, new Error(reason), true);
  settleAll(live, reason);
  live.connection?.close();
  live.http.closeAllConnections();
  live.http.close();
  if (live.done) live.proc.child.stdin.end();
  else {
    live.proc.child.kill("SIGKILL");
    await live.proc.exited;
  }
}

function closeLive(live: Live, reason: string): Promise<void> {
  return closeOnce(live, reason, teardown);
}

function fail(live: Live, error: Error): void {
  if (live.closed) return swallow("antigravity: failure after the turn closed", error);
  live.failure ??= error;
  const step = live.step;
  live.step = undefined;
  if (step) abandon(step, live.failure, false);
  else swallow("antigravity: failure held for the next step", error);
  void closeLive(live, errMessage(live.failure));
}

function acpFailure(error: unknown): Error {
  if (error instanceof HarnessFailure) return error;
  if (error instanceof acp.RequestError)
    return new HarnessFailure(`Antigravity: ${error.message}`, {
      type: error.code === AUTH_REQUIRED ? "authentication_error" : "api_error",
      code: String(error.code),
      ...(error.data === undefined ? {} : { body: error.data }),
    });
  return asError(error);
}

function startsServedTool(live: Live, toolCall: object): boolean {
  const name = (toolCall as { name?: unknown }).name;
  return typeof name === "string" && live.started.has(name);
}

function foreignTool(toolCall: acp.ToolCallUpdate): HarnessFailure {
  const named = (toolCall as { name?: unknown }).name;
  return new HarnessFailure(
    `Antigravity started ${String(named ?? toolCall.title ?? toolCall.toolCallId)}, which is not a tool QM serves; QM stopped the turn`,
    { type: "permission_error", code: "foreign_tool" },
  );
}

function onUpdate(live: Live, update: acp.SessionUpdate): void {
  if (update.sessionUpdate === "tool_call") {
    if (!startsServedTool(live, update)) fail(live, foreignTool(update));
    return;
  }
  if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") return;
  if (update.content.type !== "text") return;
  const kind = update.sessionUpdate === "agent_message_chunk" ? "text" : "thinking";
  if (live.step) append(live.step, kind, update.content.text);
  else live.backlog.push({ kind, text: update.content.text });
}

function callTool(live: Live, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (live.closed) return Promise.resolve({ content: [{ type: "text", text: "QM ended the turn" }], isError: true });
  if (!live.served.has(name)) throw new Error(`QM does not serve a tool named ${name}`);
  return new Promise((settle) => {
    live.queued.push({ id: `agy_${randomBytes(12).toString("hex")}`, name, arguments: args, settle });
    handOut(live);
  });
}

function toolServer(live: Live, tools: readonly ServedTool[], secret: string) {
  const listed = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
    _meta: { [ALWAYS_LOAD]: true },
  }));
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (!constantTimeEqual(req.headers.authorization ?? "", `Bearer ${secret}`)) {
      res.writeHead(401).end();
      return;
    }
    const server = qmToolServer(ANTIGRAVITY_MCP_SERVER, listed, (request) =>
      callTool(live, request.params.name, request.params.arguments ?? {}),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.once("close", () => void transport.close().catch((e: unknown) => swallow("antigravity: closing MCP", e)));
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      swallow("antigravity: serving QM's tools", e);
      if (!res.headersSent) res.writeHead(500).end(errMessage(e));
    }
  };
}

function textOf(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

function rendered(message: Message): string[] {
  if (message.role === "user") return [`[user]\n${textOf(message.content)}`];
  if (message.role === "toolResult")
    return [`[${message.toolName} ${message.isError ? "failed" : "result"}]\n${textOf(message.content)}`];
  const parts = message.content.flatMap((block) => {
    if (block.type === "text") return block.text.trim() ? [block.text] : [];
    if (block.type === "toolCall") return [`[called ${block.name} ${JSON.stringify(block.arguments)}]`];
    return [];
  });
  return parts.length ? [`[assistant]\n${parts.join("\n")}`] : [];
}

function userBlocks(content: string | (TextContent | ImageContent)[]): acp.ContentBlock[] {
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  return content.flatMap((block): acp.ContentBlock[] => {
    if (block.type === "image") return [{ type: "image", data: block.data, mimeType: block.mimeType }];
    return block.text.trim() ? [{ type: "text", text: block.text }] : [];
  });
}

function promptBlocks(messages: readonly Message[]): acp.ContentBlock[] {
  const last = messages.at(-1);
  const latest = last?.role === "user" ? userBlocks(last.content) : [];
  const history = (latest.length ? messages.slice(0, -1) : messages).flatMap(rendered);
  return [
    ...(history.length
      ? [{ type: "text" as const, text: `<qm_history>\n${history.join("\n\n")}\n</qm_history>` }]
      : []),
    ...(latest.length ? latest : [{ type: "text" as const, text: RESUMED_AT_TOOL_RESULTS }]),
  ];
}

function sendable(value: unknown): AntigravityRequest {
  const request = value as Partial<AntigravityRequest> | null;
  const message = Array.isArray(request?.messages) && request.messages.length === 1 ? request.messages[0] : undefined;
  if (
    !request ||
    typeof request.model !== "string" ||
    typeof request.system !== "string" ||
    message?.role !== "user" ||
    !Array.isArray(message.content) ||
    !Array.isArray(request.tools)
  )
    throw new Error("QM's request hook returned a payload the Antigravity route cannot send");
  refuseUnsent(
    "Antigravity",
    Object.keys(request).filter((key) => !SENT_FIELDS.has(key)),
  );
  return request as AntigravityRequest;
}

function continues(live: Live | undefined, messages: readonly Message[]): live is Live {
  if (!live || live.step || !live.handedOut.length || (!live.failure && (live.closed || live.done))) return false;
  return answersToolCalls(messages, live.handedOut);
}

function lost(live: Live, error: unknown): void {
  if (live.closed) return swallow("antigravity: error after the turn closed", error);
  if (!live.connection?.signal.aborted) return fail(live, acpFailure(error));
  live.dropped = error;
  live.proc.child.kill("SIGKILL");
}

async function prompt(live: Live, blocks: acp.ContentBlock[]): Promise<void> {
  const index = ++live.prompts;
  try {
    const response = await live.connection!.agent.request("session/prompt", {
      sessionId: live.sessionId!,
      prompt: blocks,
    });
    credit(live, response);
    if (index === live.prompts) return finish(live, response);
    if (response.stopReason !== "end_turn")
      console.error(`[antigravity] prompt ${index} ended (${response.stopReason}) after a steer superseded it`);
  } catch (error) {
    lost(live, error);
  }
}

function credit(live: Live, response: acp.PromptResponse): void {
  const usage = (response as { usage?: PromptUsage | null }).usage;
  if (!usage) return;
  const into = live.step?.output.usage ?? live.unbilled;
  into.input += usage.inputTokens;
  into.output += usage.outputTokens;
  into.cacheRead += usage.cachedReadTokens ?? 0;
  into.cacheWrite += usage.cachedWriteTokens ?? 0;
  into.totalTokens += usage.totalTokens;
  into.cost = calculateCost(live.model, into);
}

function finish(live: Live, response: acp.PromptResponse): void {
  live.done = true;
  const step = live.step;
  if (!step) {
    console.error(
      `[antigravity] the prompt ended (${response.stopReason}) while QM still held tool calls ${live.handedOut.join(", ")}; the next request restarts from QM's transcript`,
    );
    live.handedOut = [];
    void closeLive(live, "Antigravity ended the prompt before QM answered its tool calls");
    return;
  }
  if (response.stopReason === "end_turn") endStep(live, "stop");
  else if (response.stopReason === "max_tokens") endStep(live, "length");
  else {
    live.step = undefined;
    const refusal = response.stopReason === "refusal";
    abandon(
      step,
      new HarnessFailure(
        refusal ? "The model declined to continue (refusal)" : `Antigravity stopped the prompt: ${response.stopReason}`,
        { type: refusal ? "refusal" : "api_error", code: response.stopReason },
      ),
      response.stopReason === "cancelled",
    );
  }
  void closeLive(live, "The Antigravity prompt ended");
}

function clientApp(target: () => Live) {
  return acp
    .client({ name: "qm" })
    .onNotification("session/update", ({ params }) => onUpdate(target(), params.update))
    .onRequest("session/request_permission", ({ params }) => {
      const live = target();
      const allow = params.options.find((option) => option.kind === "allow_once");
      const served = startsServedTool(live, params.toolCall);
      if (served && allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
      fail(
        live,
        !served
          ? foreignTool(params.toolCall)
          : new HarnessFailure(
              `Antigravity asked to run ${String((params.toolCall as { name?: unknown }).name)} without a one-time approval option (offered: ${params.options.map((option) => option.kind).join(", ")}); QM stopped the turn`,
              { type: "permission_error", code: "no_allow_once" },
            ),
      );
      return { outcome: { outcome: "cancelled" } };
    });
}

interface AntigravityConnection {
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  close(): Promise<void>;
}

export function createAntigravityConnection(launch = launchAntigravity): AntigravityConnection {
  const slot = harnessSlot<Live>("antigravity", closeLive, fail);

  const attach = (target: Live, step: Step, messages: readonly Message[], signal: AbortSignal | undefined) => {
    target.handedOut = [];
    if (target.failure) return abandon(step, target.failure, false);
    target.step = step;
    step.output.usage = target.unbilled;
    target.unbilled = zeroUsage();
    slot.bindAbort(target, signal);
    for (const { kind, text } of target.backlog.splice(0)) append(step, kind, text);
    const tail = messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1);
    const steer = tail.flatMap((message) => (message.role === "user" ? userBlocks(message.content) : []));
    const settle = () => {
      for (const message of tail) {
        if (message.role !== "toolResult") continue;
        const call = target.awaiting.get(message.toolCallId);
        target.awaiting.delete(message.toolCallId);
        call?.settle(mcpResult(message));
      }
    };
    if (!steer.length) settle();
    else {
      const superseded = target.prompting;
      target.prompting = prompt(target, steer);
      void superseded?.then(settle);
    }
    handOut(target);
  };

  const start = async (
    model: Model<Api>,
    request: AntigravityRequest,
    profile: string,
    step: Step,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    await slot.supersede();
    if (slot.closed) return abandon(step, new Error("QM ended the turn"), true);
    const proc = launch(profile);
    const secret = randomBytes(32).toString("base64url");
    const target: Live = {
      model,
      proc,
      http: createServer(),
      served: new Set(request.tools.map((tool) => tool.name)),
      started: new Set(request.tools.map((tool) => AGY_TOOL_PREFIX + tool.name)),
      step,
      backlog: [],
      queued: [],
      awaiting: new Map(),
      handedOut: [],
      prompts: 0,
      unbilled: zeroUsage(),
      done: false,
      closed: false,
    };
    slot.adopt(target);
    target.http.on("request", toolServer(target, request.tools, secret));
    void proc.exited.then((how) => {
      if (target.closed || target.done) return;
      const reason = target.dropped === undefined ? "" : ` (${errMessage(target.dropped)})`;
      fail(target, new HarnessFailure(`Antigravity ${how} before the turn finished${reason}`, { type: "api_error" }));
    });
    slot.bindAbort(target, signal);
    await new Promise<void>((resolve) => target.http.listen(0, "127.0.0.1", resolve));
    if (target.closed) return;
    const { port } = target.http.address() as AddressInfo;
    target.connection = clientApp(() => target).connect(
      acp.ndJsonStream(
        Writable.toWeb(proc.child.stdin),
        Readable.toWeb(proc.child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    const agent = target.connection.agent;
    try {
      await agent.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const session = await agent.request("session/new", {
        cwd: ANTIGRAVITY_WORKSPACE,
        mcpServers: [
          {
            type: "http",
            name: ANTIGRAVITY_MCP_SERVER,
            url: `http://127.0.0.1:${port}/mcp`,
            headers: [{ name: "Authorization", value: `Bearer ${secret}` }],
          },
        ],
        _meta: { antigravity: { systemPrompt: { append: request.system } } },
      });
      const sessionId = session.sessionId;
      await agent.request("session/set_config_option", { sessionId, configId: "model", value: request.model });
      if (request.thought_level)
        await agent.request("session/set_config_option", {
          sessionId,
          configId: "thought_level",
          value: request.thought_level,
        });
      target.sessionId = sessionId;
    } catch (error) {
      return lost(target, error);
    }
    if (!target.closed) await (target.prompting = prompt(target, request.messages[0].content));
  };

  return {
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const step: Step = { stream, output: harnessOutput(model), started: false };
      const profile = options?.apiKey;
      const refusal = profile
        ? undefined
        : new HarnessFailure("The Antigravity route needs this instance's Antigravity login", {
            type: "authentication_error",
          });
      slot.run(
        step,
        refusal,
        async () => {
          const messages = context.messages;
          const thought = options?.reasoning ? model.thinkingLevelMap?.[options.reasoning] : undefined;
          const request: AntigravityRequest = {
            model: antigravityServedModelId(model.id),
            ...(thought ? { thought_level: thought } : {}),
            system: context.systemPrompt ?? "",
            messages: [{ role: "user", content: promptBlocks(messages) }],
            tools: (context.tools ?? []).map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          };
          const continuing = continues(slot.current, messages) ? slot.current : undefined;
          const shaped = await options?.onPayload?.(request, model);
          const sent = sendable(shaped === undefined ? request : shaped);
          if (continuing) attach(continuing, step, messages, options?.signal);
          else await start(model, sent, profile!, step, options?.signal);
        },
        acpFailure,
      );
      return stream;
    },
    close: () => slot.close(),
  };
}
