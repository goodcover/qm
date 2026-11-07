import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  EventStream,
  parseStreamingJson,
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
  type ToolCall,
  type ToolResultMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { MAX_TOOL_RESULT_CHARS } from "../agent/agent-tools/record.ts";
import { hashId } from "../util/crypto.ts";
import { asError, errMessage, swallow } from "../util/errors.ts";
import { claudeCodeNativeId, isClaudeSubscriptionToken } from "./claude-subscription.ts";
import { zeroUsage } from "./model-runtime.ts";
import { providerBaseUrl } from "./provider-endpoints.ts";

const SERVER = "qm";
const TOOL_PREFIX = `mcp__${SERVER}__`;
const ANTHROPIC_TOOL_NAME_LIMIT = 64;
const TOOL_USE_ID = "claudecode/toolUseId";
const CLIENT_APP = "qm/claude-code-provider";
const WORK_DIR = join(tmpdir(), "qm-claude-code-cwd");
const RESUMED_AT_TOOL_RESULTS = "[system] The run resumed after the tool results above. Continue the task.";

const QM_RESULT_CAP_AS_TOKENS = String(MAX_TOOL_RESULT_CHARS);
const NEVER_RESUME_INTERRUPTED_TURN_AGE_MS = "1";

const ERROR_TYPES: Record<SDKAssistantMessageError, string> = {
  authentication_failed: "authentication_error",
  cloud_credential_error: "authentication_error",
  oauth_org_not_allowed: "permission_error",
  account_on_hold: "permission_error",
  verification_required: "permission_error",
  billing_error: "invalid_request_error",
  invalid_request: "invalid_request_error",
  max_output_tokens: "invalid_request_error",
  rate_limit: "rate_limit_error",
  overloaded: "overloaded_error",
  model_not_found: "not_found_error",
  server_error: "api_error",
  unknown: "api_error",
};

function claudeCodeEnv(token: string, home: string, longestToolDescription = 0): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "0",
    DISABLE_COMPACT: "1",
    CLAUDE_CODE_SILENT_TURN_REMINDER: "0",
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: NEVER_RESUME_INTERRUPTED_TURN_AGE_MS,
    MAX_MCP_OUTPUT_TOKENS: QM_RESULT_CAP_AS_TOKENS,
    ...(longestToolDescription ? { CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: String(longestToolDescription) } : {}),
  };
}

class ClaudeCodeFailure extends Error {
  readonly providerError: ProviderErrorInfo;
  constructor(message: string, providerError: ProviderErrorInfo) {
    super(message);
    this.providerError = providerError;
  }
}

interface ServedTool {
  name: string;
  description: string;
  input_schema: unknown;
}

interface ClaudeCodeRequest {
  model: string;
  system: string;
  messages: TranscriptMessage[];
  tools: ServedTool[];
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
  input: EventStream<SDKUserMessage, void>;
  served: Map<string, string>;
  waiting: Map<string, (result: CallToolResult) => void>;
  ready: Map<string, CallToolResult>;
  step?: Step;
  awaiting: string[];
  failure?: Error;
  apiError?: { kind: SDKAssistantMessageError; text: string };
  child?: ChildProcess;
  exit?: string;
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

function newStep(stream: AssistantMessageEventStream, model: Model<Api>): Step {
  return {
    stream,
    output: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    },
    started: false,
    open: new Map(),
    json: new Map(),
    calls: [],
    billed: zeroUsage(),
    current: zeroUsage(),
  };
}

function toolCallId(id: string): string {
  return `toolu_${hashId([id], 32)}`;
}

function isToolCall(block: AssistantMessage["content"][number]): block is ToolCall {
  return block.type === "toolCall";
}

function imageBlock(image: ImageContent): ContentBlock {
  return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
}

function textBlocks(text: string): ContentBlock[] {
  return text.trim() ? [{ type: "text", text: text.toWellFormed() }] : [];
}

function userBlocks(content: string | (TextContent | ImageContent)[]): ContentBlock[] {
  if (typeof content === "string") return textBlocks(content);
  return content.flatMap((block) => (block.type === "text" ? textBlocks(block.text) : [imageBlock(block)]));
}

function messageBlocks(message: Message): ContentBlock[] {
  if (message.role === "user") return userBlocks(message.content);
  if (message.role === "toolResult")
    return [
      {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content.map((block) =>
          block.type === "text" ? { type: "text", text: block.text.toWellFormed() } : imageBlock(block),
        ),
        ...(message.isError ? { is_error: true } : {}),
      },
    ];
  return message.content.flatMap((block): ContentBlock[] => {
    if (block.type === "text") return textBlocks(block.text);
    if (block.type === "thinking")
      return block.thinkingSignature && !block.redacted
        ? [{ type: "thinking", thinking: block.thinking, signature: block.thinkingSignature }]
        : [];
    return [{ type: "tool_use", id: block.id, name: TOOL_PREFIX + block.name, input: block.arguments }];
  });
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

function isRequest(value: unknown): value is ClaudeCodeRequest {
  const request = value as Partial<ClaudeCodeRequest> | null;
  return (
    !!request &&
    typeof request.model === "string" &&
    typeof request.system === "string" &&
    Array.isArray(request.messages) &&
    Array.isArray(request.tools)
  );
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
        ? { type: "text" as const, text: block.text.toWellFormed() }
        : { type: "image" as const, data: block.data, mimeType: block.mimeType },
    ),
    ...(result.isError ? { isError: true } : {}),
  };
}

function unservable(tools: readonly ServedTool[]): string[] {
  return tools.flatMap((tool) => {
    const schema = tool.input_schema as Record<string, unknown>;
    if (schema.type !== "object" || ["anyOf", "oneOf", "allOf"].some((key) => key in schema))
      return [`${tool.name} (its parameters are not a plain object schema)`];
    return tool.name.length > ANTHROPIC_TOOL_NAME_LIMIT
      ? [`${tool.name} (longer than the ${ANTHROPIC_TOOL_NAME_LIMIT}-character tool name limit)`]
      : [];
  });
}

function toolServer(tools: readonly ServedTool[], live: Live) {
  const server = new McpServer({ name: SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name.slice(TOOL_PREFIX.length),
      description: tool.description,
      inputSchema: tool.input_schema as { type: "object" },
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, (request) => {
    const id = request.params._meta?.[TOOL_USE_ID];
    if (!live.served.has(TOOL_PREFIX + request.params.name))
      throw new Error(`QM does not serve a tool named ${request.params.name}`);
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

function effortFor(model: Model<Api>, reasoning: string | undefined): EffortLevel | undefined {
  if (!reasoning) return undefined;
  const mapped = model.thinkingLevelMap?.[reasoning as keyof NonNullable<Model<Api>["thinkingLevelMap"]>];
  if (typeof mapped === "string") return mapped as EffortLevel;
  if (reasoning === "minimal" || reasoning === "low") return "low";
  return reasoning === "medium" ? "medium" : "high";
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
  usage.cacheWrite1h = (step.billed.cacheWrite1h ?? 0) + (step.current.cacheWrite1h ?? 0);
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
  step.output.errorMessage = errMessage(error);
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
    const usage =
      (
        event.message as {
          usage?: Record<string, number | undefined> & { cache_creation?: { ephemeral_1h_input_tokens?: number } };
        }
      ).usage ?? {};
    step.current = {
      ...zeroUsage(),
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
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
      const json = (step.json.get(index) ?? "") + (delta.partial_json ?? "");
      step.json.set(index, json);
      block.arguments = parseStreamingJson(json);
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
      block.arguments = parseStreamingJson(step.json.get(index));
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
    step.current = zeroUsage();
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
  return new ClaudeCodeFailure(text || live.apiError?.text || `Claude Code failed${kind ? ` (${kind})` : ""}`, {
    ...(typeof status === "number" ? { status } : {}),
    ...(kind ? { type: ERROR_TYPES[kind], code: kind } : {}),
  });
}

function fail(live: Live, error: Error): void {
  if (live.failure) swallow("claude-code: later failure", error);
  else live.failure = error;
  const step = live.step;
  live.step = undefined;
  if (step) failStep(step, live.failure, false);
  else swallow("claude-code: failure held for the next step", error);
}

function onMessage(live: Live, message: SDKMessage): void {
  if (message.type === "system" && message.subtype === "init") {
    const servers = message.mcp_servers.map((server) => `${server.name}=${server.status}`).join(", ");
    const foreign = message.tools.filter((name) => !live.served.has(name));
    const missing = [...live.served.keys()].filter((name) => !message.tools.includes(name));
    if (foreign.length || missing.length)
      throw new ClaudeCodeFailure(
        `Claude Code's tools differ from QM's: extra [${foreign.join(", ")}], missing [${missing.join(", ")}], MCP servers [${servers}]`,
        { type: "invalid_request_error" },
      );
    if (message.apiKeySource !== "none")
      throw new ClaudeCodeFailure(
        `Claude Code reported API key source ${message.apiKeySource}; this route only uses a subscription login`,
        { type: "permission_error" },
      );
    console.error(
      `[claude-code] query started cc=${message.claude_code_version} model=${message.model} apiKeySource=${message.apiKeySource} tools=${message.tools.length}`,
    );
    return;
  }
  if (message.type === "auth_status" && message.error) {
    console.error(`[claude-code] auth_status ${JSON.stringify(message)}`);
    return;
  }
  if (message.type === "system" && message.subtype !== "status") {
    console.error(`[claude-code] ${message.subtype} ${JSON.stringify(message)}`);
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
    return;
  }
  if (message.type === "rate_limit_event") {
    const info = message.rate_limit_info;
    console.error(`[claude-code] subscription limit ${JSON.stringify(info)}`);
    if (info.isUsingOverage === true || info.overageInUse === true)
      throw new ClaudeCodeFailure(
        "Claude reported that this request is drawing on extra usage (overage); the claude-code route refuses metered usage",
        { type: "invalid_request_error", code: "overage_in_use" },
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
    const text =
      message.subtype === "success"
        ? message.result
        : `${message.subtype}${message.terminal_reason ? ` (${message.terminal_reason})` : ""}: ${message.errors.join("; ")}`;
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
    child.once("exit", (code, signal) => {
      live.exit = `exit code ${code ?? "none"}, signal ${signal ?? "none"}`;
      live.markExited();
    });
    child.once("error", (error) => {
      live.exit = `spawn error: ${errMessage(error)}`;
      live.markExited();
    });
    return child as unknown as SpawnedProcess;
  };
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
    swallow("claude-code: closing the query", e);
  }
  if (!live.child) live.markExited();
  await live.exited;
  try {
    rmSync(live.dir, { recursive: true, force: true });
  } catch (e) {
    swallow("claude-code: removing the query directory", e);
  }
}

function refusalFor(closed: boolean, token: string | undefined, gateway: boolean): ClaudeCodeFailure | undefined {
  if (closed) return new ClaudeCodeFailure("This model runtime has been closed", { type: "invalid_request_error" });
  if (!isClaudeSubscriptionToken(token))
    return new ClaudeCodeFailure(
      "Claude Code models need a Claude subscription OAuth token; this route never uses a metered API key",
      { type: "authentication_error" },
    );
  if (gateway)
    return new ClaudeCodeFailure(
      "This deployment routes models through a model gateway, which Claude Code would bypass",
      { type: "invalid_request_error" },
    );
  const baseUrl = providerBaseUrl("anthropic");
  return baseUrl
    ? new ClaudeCodeFailure(
        `This deployment sends Anthropic traffic through ${baseUrl}, which Claude Code would bypass`,
        {
          type: "invalid_request_error",
        },
      )
    : undefined;
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

export function createClaudeCodeConnection({ gateway = false }: { gateway?: boolean } = {}): ClaudeCodeConnection {
  let live: Live | undefined;
  let connectionClosed = false;

  const bindAbort = (target: Live, signal: AbortSignal | undefined) => {
    if (!signal) return;
    if (signal.aborted) {
      void closeLive(target, "The run was aborted");
      return;
    }
    signal.addEventListener("abort", () => void closeLive(target, "The run was aborted"), { once: true });
  };

  const attach = (target: Live, step: Step, messages: readonly Message[], signal: AbortSignal | undefined) => {
    target.awaiting = [];
    if (target.failure) {
      failStep(step, target.failure, false);
      return;
    }
    const tail = messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1);
    target.step = step;
    bindAbort(target, signal);
    const steer = tail.flatMap((message) => (message.role === "user" ? userBlocks(message.content) : []));
    if (steer.length) target.input.push(userMessage(steer));
    for (const message of tail)
      if (message.role === "toolResult") deliver(target, message.toolCallId, mcpResult(message));
  };

  const start = async (
    model: Model<Api>,
    request: ClaudeCodeRequest,
    token: string,
    step: Step,
    signal: AbortSignal | undefined,
    reasoning: string | undefined,
  ): Promise<void> => {
    const previous = live;
    live = undefined;
    if (previous) await closeLive(previous, "Superseded by a new request");
    const lost = unservable(request.tools);
    if (lost.length)
      throw new ClaudeCodeFailure(`Claude Code cannot receive these QM tools: ${lost.join("; ")}`, {
        type: "invalid_request_error",
      });
    mkdirSync(WORK_DIR, { recursive: true });
    const work = realpathSync(WORK_DIR);
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const managed = (await sdk.resolveSettings({ settingSources: [], cwd: work })).sources.filter(
      (source) => source.source === "managed",
    );
    if (managed.length)
      throw new ClaudeCodeFailure(
        `Claude Code managed settings (${managed.map((source) => source.path ?? source.policyOrigin ?? "policy").join(", ")}) would apply to QM's queries; refusing to start Claude Code`,
        { type: "permission_error" },
      );
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "qm-claude-code-")));
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => (markExited = resolve));
    const target: Live = {
      model,
      input: new EventStream<SDKUserMessage, void>(
        () => false,
        () => undefined,
      ),
      served: new Map(request.tools.map((tool) => [tool.name, tool.name.slice(TOOL_PREFIX.length)])),
      waiting: new Map(),
      ready: new Map(),
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
      const session = createSession({ projectPath: work, claudeDir: dir, cwd: work, model: request.model, sessionId });
      session.importMessages(history);
      session.save();
    }
    const effort = effortFor(model, reasoning);
    const longest = Math.max(0, ...request.tools.map((tool) => tool.description.length));
    const options: Options = {
      cwd: work,
      env: claudeCodeEnv(token, dir, longest),
      systemPrompt: request.system,
      model: request.model,
      tools: [],
      allowedTools: [...target.served.keys()],
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      settings: { autoMemoryEnabled: false },
      includePartialMessages: true,
      verbatimPrompts: true,
      extraArgs: { "disable-slash-commands": null },
      ...(request.tools.length ? { mcpServers: { [SERVER]: toolServer(request.tools, target) } } : {}),
      ...(history.length ? { resume: sessionId } : { sessionId }),
      ...(effort ? { effort } : {}),
      ...(!reasoning && model.reasoning && model.thinkingLevelMap?.off !== null
        ? { thinking: { type: "disabled" as const } }
        : {}),
      spawnClaudeCodeProcess: spawnTracked(target),
    };
    if (target.closed || connectionClosed) return closeLive(target, "QM ended the turn");
    target.query = sdk.query({ prompt: target.input, options });
    target.input.push(userMessage(prompt));
    try {
      for await (const message of target.query) {
        if (target.closed) break;
        onMessage(target, message);
      }
      if (!target.closed && !target.finished) {
        await target.exited;
        const ended = `Claude Code ended without a result (${target.exit ?? "process state unknown"})`;
        throw apiFailure(target, [target.apiError?.text, ended].filter(Boolean).join(" — "), undefined);
      }
    } catch (error) {
      if (target.closed) swallow("claude-code: error after the query was closed", error);
      else fail(target, asError(error));
    } finally {
      if (target.failure || target.finished) await closeLive(target, "The Claude Code query ended");
    }
  };

  return {
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const step = newStep(stream, model);
      const token = options?.apiKey;
      const refusal = refusalFor(connectionClosed, token, gateway);
      if (refusal) {
        queueMicrotask(() => failStep(step, refusal, false));
        return stream;
      }
      const messages = transformMessages(context.messages, model, toolCallId);
      const request: ClaudeCodeRequest = {
        model: claudeCodeNativeId(model.id),
        system: (context.systemPrompt ?? "").toWellFormed(),
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
        if (shaped !== undefined && !isRequest(shaped))
          throw new Error("QM's request hook returned a payload the claude-code route cannot send");
        if (continuing) attach(continuing, step, messages, options?.signal);
        else await start(model, shaped ?? request, token!, step, options?.signal, options?.reasoning);
      })().catch((error) => {
        const failure = asError(error);
        if (live?.step === step) fail(live, failure);
        else if (!step.output.errorMessage) failStep(step, failure, false);
        else swallow("claude-code: failure after the step ended", failure);
      });
      return stream;
    },
    async close() {
      connectionClosed = true;
      const current = live;
      live = undefined;
      if (current) await closeLive(current, "QM ended the turn");
    },
  };
}
