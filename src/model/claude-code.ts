import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EffortLevel,
  Options,
  Query,
  SDKAssistantMessageError,
  SDKMessage,
  SDKUserMessage,
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createSession, type ContentBlock, type Message as TranscriptMessage } from "cc-session-io";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type ProviderErrorInfo,
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { CLAUDE_CODE_PREFIX, isClaudeSubscriptionToken } from "./claude-subscription.ts";

const SERVER = "qm";
const TOOL_PREFIX = `mcp__${SERVER}__`;
const TOOL_USE_ID = "claudecode/toolUseId";
const CLIENT_APP = "qm/claude-code-provider";
const EXIT_GRACE_MS = 5_000;
const RESUMED_AT_TOOL_RESULTS = "[system] The run resumed after the tool results above. Continue the task.";
const ACCEPTED_KEY_SOURCES = new Set(["none", "oauth"]);
const CLAUDE_CODE_MCP_DESCRIPTION_LIMIT = 4096;

const EFFORT: Record<string, EffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

const ERROR_TYPES: Record<SDKAssistantMessageError, { type: string; status: number }> = {
  authentication_failed: { type: "authentication_error", status: 401 },
  oauth_org_not_allowed: { type: "permission_error", status: 403 },
  account_on_hold: { type: "permission_error", status: 403 },
  verification_required: { type: "permission_error", status: 403 },
  cloud_credential_error: { type: "authentication_error", status: 401 },
  billing_error: { type: "billing_error", status: 400 },
  rate_limit: { type: "rate_limit_error", status: 429 },
  overloaded: { type: "overloaded_error", status: 529 },
  invalid_request: { type: "invalid_request_error", status: 400 },
  max_output_tokens: { type: "invalid_request_error", status: 400 },
  model_not_found: { type: "not_found_error", status: 404 },
  server_error: { type: "api_error", status: 500 },
  unknown: { type: "api_error", status: 500 },
};

export function claudeCodeEnv(token: string, home: string): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    CLAUDE_CONFIG_DIR: home,
    TMPDIR: home,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "0",
    DISABLE_AUTO_COMPACT: "1",
    CLAUDE_CODE_SILENT_TURN_REMINDER: "0",
    CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "1",
  };
}

class ClaudeCodeFailure extends Error {
  readonly providerError: ProviderErrorInfo;
  constructor(message: string, providerError: ProviderErrorInfo) {
    super(message);
    this.providerError = providerError;
  }
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  push(message: SDKUserMessage): void {
    this.items.push(message);
    this.wake?.();
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

interface Step {
  stream: AssistantMessageEventStream;
  output: AssistantMessage;
  started: boolean;
  open: Map<number, number>;
  json: Map<number, string>;
  calls: string[];
  billed: Usage;
  current: Usage;
}

interface Live {
  query?: Query;
  model: Model<Api>;
  input: InputQueue;
  served: Map<string, string>;
  waiting: Map<string, (result: CallToolResult) => void>;
  ready: Map<string, CallToolResult>;
  inputs: Map<string, Record<string, unknown>>;
  step?: Step;
  awaiting: string[];
  failure?: Error;
  apiError?: { kind: SDKAssistantMessageError; text: string };
  child?: ChildProcess;
  exited: Promise<void>;
  markExited: () => void;
  dir: string;
  closed: boolean;
  finished: boolean;
}

interface ClaudeCodeConnection {
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  close(): Promise<void>;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function newOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function nativeModelId(model: Model<Api>): string {
  return model.id.startsWith(CLAUDE_CODE_PREFIX) ? model.id.slice(CLAUDE_CODE_PREFIX.length) : model.id;
}

function toolCallId(id: string): string {
  return `toolu_${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

function isToolCall(block: AssistantMessage["content"][number]): block is ToolCall {
  return block.type === "toolCall";
}

function imageBlock(image: ImageContent): ContentBlock {
  return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
}

function textBlocks(text: string): ContentBlock[] {
  return text ? [{ type: "text", text }] : [];
}

function userBlocks(content: string | (TextContent | ImageContent)[]): ContentBlock[] {
  if (typeof content === "string") return textBlocks(content);
  return content.flatMap((block) => (block.type === "text" ? textBlocks(block.text) : [imageBlock(block)]));
}

function resultBlocks(result: ToolResultMessage): ContentBlock[] {
  return result.content.map((block) =>
    block.type === "text" ? { type: "text", text: block.text } : imageBlock(block),
  );
}

function assistantBlocks(message: AssistantMessage): ContentBlock[] {
  return message.content.flatMap((block): ContentBlock[] => {
    if (block.type === "text") return block.text ? [{ type: "text", text: block.text }] : [];
    if (block.type === "thinking")
      return block.thinkingSignature && !block.redacted
        ? [{ type: "thinking", thinking: block.thinking, signature: block.thinkingSignature }]
        : [];
    return [{ type: "tool_use", id: block.id, name: TOOL_PREFIX + block.name, input: block.arguments }];
  });
}

function messageBlocks(message: Message): ContentBlock[] {
  if (message.role === "assistant") return assistantBlocks(message);
  if (message.role === "user") return userBlocks(message.content);
  return [
    {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: resultBlocks(message),
      ...(message.isError ? { is_error: true } : {}),
    },
  ];
}

function claudeCodeTranscript(history: readonly Message[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const message of history) {
    const content = messageBlocks(message);
    if (!content.length) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const previous = out.at(-1);
    if (previous?.role === role && Array.isArray(previous.content)) previous.content.push(...content);
    else out.push({ role, content });
  }
  return out;
}

interface ClaudeCodeRequest {
  model: string;
  system: string;
  messages: TranscriptMessage[];
  tools: { name: string; description: string; input_schema: unknown }[];
}

function isRequest(value: unknown): value is ClaudeCodeRequest {
  const request = value as Partial<ClaudeCodeRequest> | null;
  return !!request && typeof request === "object" && Array.isArray(request.messages);
}

function splitPrompt(messages: readonly TranscriptMessage[]): {
  history: TranscriptMessage[];
  prompt: ContentBlock[];
} {
  const last = messages.at(-1);
  const content = last?.role === "user" ? last.content : [];
  const blocks = typeof content === "string" ? textBlocks(content) : content;
  const results = blocks.filter((block) => block.type === "tool_result");
  const prompt = blocks.filter((block) => block.type !== "tool_result");
  if (!prompt.length) return { history: [...messages], prompt: [{ type: "text", text: RESUMED_AT_TOOL_RESULTS }] };
  const history = messages.slice(0, -1);
  return { history: results.length ? [...history, { role: "user", content: results }] : history, prompt };
}

function userMessage(content: ContentBlock[]): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: content as Exclude<SDKUserMessage["message"]["content"], string> },
    parent_tool_use_id: null,
  };
}

function mcpResult(result: ToolResultMessage): CallToolResult {
  return {
    content: result.content.map((block) =>
      block.type === "text"
        ? { type: "text" as const, text: block.text }
        : { type: "image" as const, data: block.data, mimeType: block.mimeType },
    ),
    ...(result.isError ? { isError: true } : {}),
  };
}

function unservable(tools: readonly Tool[]): string[] {
  return tools.flatMap((tool) => {
    const schema = tool.parameters as Record<string, unknown>;
    if (schema.type !== "object" || ["anyOf", "oneOf", "allOf"].some((key) => key in schema))
      return [`${tool.name} (its parameters are not a plain object schema)`];
    return tool.description.length > CLAUDE_CODE_MCP_DESCRIPTION_LIMIT
      ? [`${tool.name} (Claude Code truncates tool descriptions over ${CLAUDE_CODE_MCP_DESCRIPTION_LIMIT} characters)`]
      : [];
  });
}

function toolServer(tools: readonly Tool[], live: Live) {
  const server = new McpServer({ name: SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
  const names = new Set(tools.map((tool) => tool.name));
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as { type: "object" },
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, (request) => {
    const id = request.params._meta?.[TOOL_USE_ID];
    if (!names.has(request.params.name)) throw new Error(`QM does not serve a tool named ${request.params.name}`);
    if (typeof id !== "string") throw new Error(`${request.params.name}: tools/call is missing its tool_use id`);
    const ready = live.ready.get(id);
    if (ready) {
      live.ready.delete(id);
      return ready;
    }
    return new Promise<CallToolResult>((resolve) => live.waiting.set(id, resolve));
  });
  return { type: "sdk" as const, name: SERVER, instance: server };
}

function deliver(live: Live, id: string, result: CallToolResult): void {
  const waiting = live.waiting.get(id);
  if (!waiting) {
    live.ready.set(id, result);
    return;
  }
  live.waiting.delete(id);
  waiting(result);
}

function started(step: Step): void {
  if (step.started) return;
  step.started = true;
  step.stream.push({ type: "start", partial: step.output });
}

function settleUsage(step: Step, model: Model<Api>): void {
  const usage = step.output.usage;
  usage.input = step.billed.input + step.current.input;
  usage.output = step.billed.output + step.current.output;
  usage.cacheRead = step.billed.cacheRead + step.current.cacheRead;
  usage.cacheWrite = step.billed.cacheWrite + step.current.cacheWrite;
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  usage.cost = calculateCost(model, usage);
}

function endStep(live: Live, reason: "stop" | "length" | "toolUse"): void {
  const step = live.step;
  if (!step) return;
  live.step = undefined;
  started(step);
  step.output.stopReason = reason;
  step.stream.push({ type: "done", reason, message: step.output });
  step.stream.end();
}

function failStep(step: Step, error: Error, aborted: boolean): void {
  step.output.stopReason = aborted ? "aborted" : "error";
  step.output.errorMessage = error.message;
  if (error instanceof ClaudeCodeFailure) step.output.providerError = error.providerError;
  step.stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: step.output });
  step.stream.end();
}

function onStreamEvent(live: Live, event: Record<string, unknown> & { type: string }): void {
  const step = live.step;
  if (!step) return;
  const output = step.output;
  const index = event.index as number;
  if (event.type === "message_start") {
    step.open.clear();
    step.json.clear();
    const usage = (event.message as { usage?: Record<string, number | undefined> }).usage ?? {};
    step.current = {
      ...emptyUsage(),
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    };
    settleUsage(step, live.model);
    return;
  }
  if (event.type === "content_block_start") {
    const block = event.content_block as { type: string; id?: string; name?: string; data?: string };
    if (block.type === "tool_use") {
      const name = live.served.get(block.name ?? "");
      if (!name) return;
      started(step);
      output.content.push({ type: "toolCall", id: block.id!, name, arguments: {} });
      step.json.set(index, "");
      step.open.set(index, output.content.length - 1);
      step.stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
      return;
    }
    started(step);
    if (block.type === "text") {
      output.content.push({ type: "text", text: "" });
      step.open.set(index, output.content.length - 1);
      step.stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      output.content.push({
        type: "thinking",
        thinking: "",
        thinkingSignature: block.data ?? "",
        ...(block.type === "redacted_thinking" ? { redacted: true } : {}),
      });
      step.open.set(index, output.content.length - 1);
      step.stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
    }
    return;
  }
  const at = step.open.get(index);
  const block = at === undefined ? undefined : output.content[at];
  if (event.type === "content_block_delta" && block && at !== undefined) {
    const delta = event.delta as {
      type: string;
      text?: string;
      thinking?: string;
      signature?: string;
      partial_json?: string;
    };
    if (delta.type === "text_delta" && block.type === "text") {
      block.text += delta.text ?? "";
      step.stream.push({ type: "text_delta", contentIndex: at, delta: delta.text ?? "", partial: output });
    } else if (delta.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += delta.thinking ?? "";
      step.stream.push({ type: "thinking_delta", contentIndex: at, delta: delta.thinking ?? "", partial: output });
    } else if (delta.type === "signature_delta" && block.type === "thinking") {
      block.thinkingSignature = (block.thinkingSignature ?? "") + (delta.signature ?? "");
    } else if (delta.type === "input_json_delta" && block.type === "toolCall") {
      step.json.set(index, (step.json.get(index) ?? "") + (delta.partial_json ?? ""));
      step.stream.push({ type: "toolcall_delta", contentIndex: at, delta: delta.partial_json ?? "", partial: output });
    }
    return;
  }
  if (event.type === "content_block_stop" && block && at !== undefined) {
    step.open.delete(index);
    if (block.type === "text")
      step.stream.push({ type: "text_end", contentIndex: at, content: block.text, partial: output });
    else if (block.type === "thinking")
      step.stream.push({ type: "thinking_end", contentIndex: at, content: block.thinking, partial: output });
    else if (block.type === "toolCall") {
      const json = step.json.get(index) ?? "";
      block.arguments = live.inputs.get(block.id) ?? (json ? (JSON.parse(json) as Record<string, unknown>) : {});
      step.calls.push(block.id);
      step.stream.push({ type: "toolcall_end", contentIndex: at, toolCall: block, partial: output });
    }
    return;
  }
  if (event.type === "message_delta") {
    const delta = event.delta as { stop_reason?: string | null };
    const usage = event.usage as { output_tokens?: number } | undefined;
    if (usage?.output_tokens !== undefined) {
      step.current.output = usage.output_tokens;
      settleUsage(step, live.model);
    }
    if (delta.stop_reason === "refusal") output.rawStopReason = "refusal";
    if (delta.stop_reason === "max_tokens") output.stopReason = "length";
    return;
  }
  if (event.type === "message_stop") {
    const unfinished = [...step.open.values()].sort((a, b) => b - a);
    for (const contentIndex of unfinished) output.content.splice(contentIndex, 1);
    step.open.clear();
    step.billed = { ...output.usage, cost: { ...output.usage.cost } };
    step.current = emptyUsage();
    if (output.rawStopReason === "refusal") {
      live.step = undefined;
      failStep(step, new ClaudeCodeFailure("The model declined to continue (refusal)", { type: "refusal" }), false);
      return;
    }
    if (step.calls.length) {
      live.awaiting = step.calls;
      endStep(live, "toolUse");
    }
  }
}

function apiFailure(live: Live, text: string, status: number | null | undefined): ClaudeCodeFailure {
  const kind = live.apiError?.kind;
  const mapped = kind ? ERROR_TYPES[kind] : undefined;
  return new ClaudeCodeFailure(text || live.apiError?.text || "Claude Code reported an error", {
    ...((status ?? mapped?.status) ? { status: status ?? mapped?.status } : {}),
    ...(mapped ? { type: mapped.type } : {}),
    ...(kind ? { code: kind } : {}),
  });
}

function fail(live: Live, error: Error): void {
  live.failure ??= error;
  const step = live.step;
  live.step = undefined;
  if (step) failStep(step, live.failure, false);
}

function onMessage(live: Live, message: SDKMessage, servedNames: ReadonlySet<string>): void {
  if (message.type === "system" && message.subtype === "init") {
    const foreign = message.tools.filter((name) => !servedNames.has(name));
    if (foreign.length) throw new Error(`Claude Code exposed tools QM did not serve: ${foreign.join(", ")}`);
    const missing = [...servedNames].filter((name) => !message.tools.includes(name));
    if (missing.length) throw new Error(`Claude Code did not load these QM tools: ${missing.join(", ")}`);
    if (!ACCEPTED_KEY_SOURCES.has(message.apiKeySource))
      throw new Error(
        `Claude Code reported API key source ${message.apiKeySource}; this route only uses a subscription login`,
      );
    console.error(
      `[claude-code] query started cc=${message.claude_code_version} model=${message.model} apiKeySource=${message.apiKeySource} tools=${message.tools.length}`,
    );
    return;
  }
  if (message.type === "stream_event") {
    if (message.parent_tool_use_id === null)
      onStreamEvent(live, message.event as unknown as Record<string, unknown> & { type: string });
    return;
  }
  if (message.type === "assistant") {
    if (message.parent_tool_use_id !== null) return;
    if (message.error) {
      const text = message.message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim();
      live.apiError = { kind: message.error, text };
    }
    for (const block of message.message.content)
      if (block.type === "tool_use") live.inputs.set(block.id, block.input as Record<string, unknown>);
    return;
  }
  if (message.type === "rate_limit_event") {
    console.error(`[claude-code] subscription limit ${JSON.stringify(message.rate_limit_info)}`);
    if (message.rate_limit_info.isUsingOverage === true || message.rate_limit_info.overageInUse === true)
      throw new ClaudeCodeFailure(
        "Claude reported that this request is drawing on extra usage (overage); the claude-code route refuses metered usage",
        { type: "billing_error", status: 400, code: "overage_in_use" },
      );
    return;
  }
  if (message.type === "result") {
    live.finished = true;
    live.input.end();
    if (message.subtype === "success" && !message.is_error) {
      endStep(live, live.step?.output.stopReason === "length" ? "length" : "stop");
      return;
    }
    const text = message.subtype === "success" ? message.result : message.errors.join("\n");
    fail(live, apiFailure(live, text, message.subtype === "success" ? message.api_error_status : undefined));
  }
}

function spawnTracked(live: Live) {
  return (options: SpawnOptions): SpawnedProcess => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    live.child = child;
    child.stderr?.on("data", (data: Buffer) => console.error(`[claude-code] ${data.toString().trimEnd()}`));
    child.once("exit", () => live.markExited());
    child.once("error", () => live.markExited());
    return child as unknown as SpawnedProcess;
  };
}

async function stopChild(live: Live): Promise<void> {
  const child = live.child;
  if (!child) return live.markExited();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), EXIT_GRACE_MS);
  try {
    await live.exited;
  } finally {
    clearTimeout(timer);
  }
}

async function closeLive(live: Live, reason: string): Promise<void> {
  if (live.closed) return live.exited;
  live.closed = true;
  live.input.end();
  for (const [id, resolve] of live.waiting) {
    live.waiting.delete(id);
    resolve({ content: [{ type: "text", text: reason }], isError: true });
  }
  const step = live.step;
  live.step = undefined;
  if (step) failStep(step, new Error(reason), true);
  try {
    live.query?.close();
  } catch (e) {
    console.error(`[claude-code] closing the query failed: ${(e as Error).message}`);
  }
  await stopChild(live);
  rmSync(live.dir, { recursive: true, force: true });
}

function continues(live: Live | undefined, messages: readonly Message[]): live is Live {
  if (!live || live.step || !live.awaiting.length || (!live.failure && (live.closed || live.finished))) return false;
  const last = messages.findLastIndex((message) => message.role === "assistant");
  const assistant = messages[last] as AssistantMessage | undefined;
  const calls = assistant?.content.filter(isToolCall).map((call) => call.id) ?? [];
  if (calls.length !== live.awaiting.length || calls.some((id, i) => id !== live.awaiting[i])) return false;
  const answered = new Set(
    messages.slice(last + 1).flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
  );
  return calls.every((id) => answered.has(id));
}

export function createClaudeCodeConnection(): ClaudeCodeConnection {
  let live: Live | undefined;

  const attach = (target: Live, step: Step, messages: readonly Message[], signal: AbortSignal | undefined) => {
    target.awaiting = [];
    if (target.failure) {
      failStep(step, target.failure, false);
      return;
    }
    const last = messages.findLastIndex((message) => message.role === "assistant");
    const tail = messages.slice(last + 1);
    target.step = step;
    bindAbort(target, signal);
    const steer = tail.flatMap((message) => (message.role === "user" ? userBlocks(message.content) : []));
    if (steer.length) target.input.push(userMessage(steer));
    for (const message of tail)
      if (message.role === "toolResult") deliver(target, message.toolCallId, mcpResult(message));
  };

  const bindAbort = (target: Live, signal: AbortSignal | undefined) => {
    if (!signal) return;
    if (signal.aborted) {
      void closeLive(target, "The run was aborted");
      return;
    }
    signal.addEventListener("abort", () => void closeLive(target, "The run was aborted"), { once: true });
  };

  const start = async (
    model: Model<Api>,
    context: Context,
    request: ClaudeCodeRequest,
    token: string,
    step: Step,
    signal: AbortSignal | undefined,
    reasoning: string | undefined,
  ): Promise<void> => {
    const previous = live;
    live = undefined;
    if (previous) await closeLive(previous, "Superseded by a new request");
    const tools = context.tools ?? [];
    const lost = unservable(tools);
    if (lost.length)
      throw new ClaudeCodeFailure(`Claude Code cannot receive these QM tools whole: ${lost.join("; ")}`, {
        type: "invalid_request_error",
        status: 400,
      });
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "qm-claude-code-")));
    const work = join(dir, "work");
    mkdirSync(work);
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => (markExited = resolve));
    const target: Live = {
      model,
      input: new InputQueue(),
      served: new Map(tools.map((tool) => [TOOL_PREFIX + tool.name, tool.name])),
      waiting: new Map(),
      ready: new Map(),
      inputs: new Map(),
      step,
      awaiting: [],
      exited,
      markExited,
      dir,
      closed: false,
      finished: false,
    };
    live = target;
    bindAbort(target, signal);
    if (target.closed) return;
    const { history, prompt } = splitPrompt(request.messages);
    const sessionId = randomUUID();
    if (history.length) {
      const session = createSession({
        projectPath: work,
        claudeDir: dir,
        cwd: work,
        model: nativeModelId(model),
        sessionId,
      });
      session.importMessages(history);
      session.save();
    }
    const effort = reasoning ? EFFORT[reasoning] : undefined;
    const options: Options = {
      cwd: work,
      env: claudeCodeEnv(token, dir),
      systemPrompt: context.systemPrompt ?? "",
      model: nativeModelId(model),
      tools: [],
      allowedTools: [...target.served.keys()],
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      settings: { autoMemoryEnabled: false },
      includePartialMessages: true,
      ...(tools.length ? { mcpServers: { [SERVER]: toolServer(tools, target) } } : {}),
      ...(history.length ? { resume: sessionId } : { sessionId }),
      ...(effort ? { effort } : {}),
      ...(!reasoning && model.reasoning && model.thinkingLevelMap?.off !== null
        ? { thinking: { type: "disabled" as const } }
        : {}),
      spawnClaudeCodeProcess: spawnTracked(target),
    };
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    if (target.closed) return;
    target.query = query({ prompt: target.input, options });
    target.input.push(userMessage(prompt));
    const servedNames = new Set(target.served.keys());
    try {
      for await (const message of target.query) {
        if (target.closed) break;
        onMessage(target, message, servedNames);
      }
      if (!target.closed && !target.finished) throw new Error("Claude Code ended without a result");
    } catch (error) {
      if (!target.closed) fail(target, error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (target.failure || target.finished) await closeLive(target, "The Claude Code query ended");
    }
  };

  return {
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const step: Step = {
        stream,
        output: newOutput(model),
        started: false,
        open: new Map(),
        json: new Map(),
        calls: [],
        billed: emptyUsage(),
        current: emptyUsage(),
      };
      const token = options?.apiKey;
      if (!isClaudeSubscriptionToken(token)) {
        queueMicrotask(() =>
          failStep(
            step,
            new ClaudeCodeFailure(
              "Claude Code models need a Claude subscription OAuth token; this route never uses a metered API key",
              { type: "authentication_error", status: 401 },
            ),
            false,
          ),
        );
        return stream;
      }
      const messages = transformMessages(context.messages, model, toolCallId);
      const request: ClaudeCodeRequest = {
        model: nativeModelId(model),
        system: context.systemPrompt ?? "",
        messages: claudeCodeTranscript(messages),
        tools: (context.tools ?? []).map((tool) => ({
          name: TOOL_PREFIX + tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
      };
      const continuing = continues(live, messages) ? live : undefined;
      void (async () => {
        const shaped = options?.onPayload ? await options.onPayload(request, model) : undefined;
        if (continuing) attach(continuing, step, messages, options?.signal);
        else
          await start(
            model,
            context,
            isRequest(shaped) ? shaped : request,
            token!,
            step,
            options?.signal,
            options?.reasoning,
          );
      })().catch((error) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (live?.step === step) fail(live, failure);
        else if (!step.output.errorMessage) failStep(step, failure, false);
      });
      return stream;
    },
    async close() {
      const current = live;
      live = undefined;
      if (current) await closeLive(current, "QM ended the turn");
    },
  };
}
