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
  SpawnedProcess,
  SpawnOptions,
  ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createSession,
  openSession,
  type ContentBlock,
  type ImportAttachment,
  type Message as TranscriptMessage,
} from "cc-session-io";
import {
  calculateCost,
  createAssistantMessageEventStream,
  EventStream,
  parseStreamingJson,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type CacheRetention,
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
import { adjustMaxTokensForThinking, clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { MAX_TOOL_RESULT_CHARS } from "../agent/agent-tools/record.ts";
import { hashId } from "../util/crypto.ts";
import { asError, errMessage, swallow } from "../util/errors.ts";
import { isClaudeSubscriptionToken } from "./claude-subscription.ts";
import { applyThinkingBinding, withRequestHeaders, zeroUsage } from "./model-runtime.ts";
import { modelSupportsAdaptiveThinking } from "./pi-models.ts";

const SERVER = "qm";
const TOOL_PREFIX = `mcp__${SERVER}__`;
const ANTHROPIC_TOOL_NAME_LIMIT = 64;
const TOOL_USE_ID = "claudecode/toolUseId";
const CLIENT_APP = "qm/claude-code-provider";
const WORK_DIR = join(tmpdir(), "qm-claude-code-cwd");
const RESUMED_AT_TOOL_RESULTS = "[system] The run resumed after the tool results above. Continue the task.";

const RESULT_SIZE_META = "anthropic/maxResultSizeChars";
const QM_SETTINGS_SOURCE = "flagSettings";
const NEVER_RESUME_INTERRUPTED_TURN_AGE_MS = "1";
const THINKING_DISPLAY = "summarized";
const API_DEFAULT_THINKING: WireThinking = { type: "disabled" };
const API_DEFAULT_EFFORT: EffortLevel = "high";
const ANNOUNCED = new Set(["environment", "model", "date"]);
const announcements = new Map<string, ImportAttachment["attachment"][]>();

const ERROR_TYPES: Partial<Record<SDKAssistantMessageError, string>> = {
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
};

function cacheEnv(retention: CacheRetention | undefined): Record<string, string> {
  if (retention === "none") return { DISABLE_PROMPT_CACHING: "1" };
  return { CLAUDE_CODE_PROMPT_CACHE_TTL: retention === "long" ? "1h" : "5m" };
}

function claudeCodeEnv(
  token: string,
  home: string,
  longestToolDescription: number,
  maxOutputTokens: number,
  retention: CacheRetention | undefined,
): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_CODE_TMPDIR: home,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_MAX_RETRIES: "0",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
    ENABLE_CLAUDEAI_MCP_SERVERS: "0",
    DISABLE_COMPACT: "1",
    CLAUDE_CODE_SILENT_TURN_REMINDER: "0",
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: NEVER_RESUME_INTERRUPTED_TURN_AGE_MS,
    ...(longestToolDescription ? { CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: String(longestToolDescription) } : {}),
    ...cacheEnv(retention),
  };
}

class ClaudeCodeFailure extends Error {
  readonly providerError: ProviderErrorInfo;
  constructor(message: string, providerError: ProviderErrorInfo) {
    super(message);
    this.providerError = providerError;
  }
}

interface SettingsReport {
  sources?: Array<{ source?: string; settings?: Record<string, unknown> }>;
}

interface ServedTool {
  name: string;
  description: string;
  input_schema: unknown;
}

interface WireThinking {
  type: ThinkingConfig["type"];
  budget_tokens?: number;
  display?: "summarized" | "omitted";
  block_binding?: unknown;
}

interface WireToolChoice {
  type: string;
  name?: string;
}

interface ClaudeCodeRequest {
  model: string;
  system: string;
  messages: TranscriptMessage[];
  tools: ServedTool[];
  max_tokens?: number;
  thinking?: WireThinking;
  output_config?: { effort?: EffortLevel };
  speed?: string;
  tool_choice?: WireToolChoice;
}

const SENT_FIELDS: Record<keyof ClaudeCodeRequest, true> = {
  model: true,
  system: true,
  messages: true,
  tools: true,
  max_tokens: true,
  thinking: true,
  output_config: true,
  speed: true,
  tool_choice: true,
};

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
  abort: AbortController;
  model: Model<Api>;
  input: EventStream<SDKUserMessage, void>;
  served: Map<string, string>;
  waiting: Map<string, (result: CallToolResult) => void>;
  ready: Map<string, CallToolResult>;
  step?: Step;
  awaiting: string[];
  failure?: Error;
  apiError?: { kind: SDKAssistantMessageError; text: string };
  authError?: string;
  child?: ChildProcess;
  exited: Promise<void>;
  markExited: () => void;
  dir: string;
  session: string;
  toolChoice: WireToolChoice | undefined;
  closing?: Promise<void>;
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

function servedToolChoice(request: ClaudeCodeRequest): ClaudeCodeRequest {
  const choice = request.tool_choice;
  if (choice?.type !== "tool") return request;
  const name = TOOL_PREFIX + String(choice.name);
  if (!request.tools.some((tool) => tool.name === name))
    throw new ClaudeCodeFailure(`QM's request hook forces the tool ${choice.name}, which this request does not serve`, {
      type: "invalid_request_error",
    });
  return { ...request, tool_choice: { ...choice, name } };
}

function sendable(value: unknown): ClaudeCodeRequest {
  const request = value as Partial<ClaudeCodeRequest> | null;
  if (
    !request ||
    typeof request.model !== "string" ||
    typeof request.system !== "string" ||
    !Array.isArray(request.messages) ||
    !Array.isArray(request.tools)
  )
    throw new Error("QM's request hook returned a payload the claude-code route cannot send");
  const unsent = [
    ...Object.keys(request).filter((key) => !Object.hasOwn(SENT_FIELDS, key)),
    ...Object.keys(request.output_config ?? {})
      .filter((key) => key !== "effort")
      .map((key) => `output_config.${key}`),
  ];
  if (unsent.length)
    throw new ClaudeCodeFailure(`Claude Code cannot send request fields QM's request hook set: ${unsent.join(", ")}`, {
      type: "invalid_request_error",
    });
  return servedToolChoice(request as ClaudeCodeRequest);
}

function lastUserBlocks(messages: readonly TranscriptMessage[]): ContentBlock[] {
  const last = messages.at(-1);
  const content = last?.role === "user" ? last.content : [];
  return typeof content === "string" ? textBlocks(content) : content;
}

function splitPrompt(messages: readonly TranscriptMessage[]): {
  history: TranscriptMessage[];
  prompt: ContentBlock[];
} {
  const blocks = lastUserBlocks(messages);
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
      _meta: { [RESULT_SIZE_META]: MAX_TOOL_RESULT_CHARS },
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

function effortFor(model: Model<Api>, reasoning: string): EffortLevel {
  const mapped = model.thinkingLevelMap?.[reasoning as keyof NonNullable<Model<Api>["thinkingLevelMap"]>];
  if (typeof mapped === "string") return mapped as EffortLevel;
  if (reasoning === "minimal" || reasoning === "low") return "low";
  return reasoning === "medium" ? "medium" : "high";
}

function thinkingFor(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
): Pick<ClaudeCodeRequest, "max_tokens" | "thinking" | "output_config"> {
  const reasoning = options?.reasoning;
  const base = clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens);
  if (!reasoning)
    return model.reasoning && model.thinkingLevelMap?.off !== null
      ? { max_tokens: base, thinking: { type: "disabled" } }
      : { max_tokens: base };
  if (modelSupportsAdaptiveThinking(model))
    return {
      max_tokens: base,
      thinking: { type: "adaptive", display: THINKING_DISPLAY },
      output_config: { effort: effortFor(model, reasoning) },
    };
  const adjusted = adjustMaxTokensForThinking(base, model.maxTokens, reasoning, options.thinkingBudgets);
  const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
  return {
    max_tokens: maxTokens,
    thinking: {
      type: "enabled",
      budget_tokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
      display: THINKING_DISPLAY,
    },
  };
}

function sdkThinking(thinking: WireThinking): ThinkingConfig {
  const display = thinking.display ? { display: thinking.display } : {};
  if (thinking.type === "disabled") return { type: "disabled" };
  if (thinking.type === "adaptive") return { type: "adaptive", ...display };
  return { type: "enabled", ...(thinking.budget_tokens ? { budgetTokens: thinking.budget_tokens } : {}), ...display };
}

function wireOptions(
  model: Model<Api>,
  request: ClaudeCodeRequest,
): { options: Pick<Options, "thinking" | "effort">; env: Record<string, string> } {
  const headers = withRequestHeaders(model, true, false);
  const bound = (applyThinkingBinding({ thinking: request.thinking }, headers) as Pick<ClaudeCodeRequest, "thinking">)
    .thinking;
  const options = {
    thinking: sdkThinking(bound ?? API_DEFAULT_THINKING),
    effort: request.output_config?.effort ?? API_DEFAULT_EFFORT,
  };
  const betas = headers.headers?.["anthropic-beta"];
  const extraBody = {
    ...(bound?.block_binding ? { thinking: bound } : {}),
    ...(request.tool_choice ? { tool_choice: request.tool_choice } : {}),
  };
  return {
    options,
    env: {
      ...(betas ? { ANTHROPIC_BETAS: betas } : {}),
      ...(Object.keys(extraBody).length ? { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(extraBody) } : {}),
    },
  };
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
    if (output.stopReason === "length") {
      live.finished = true;
      live.input.end();
      live.child?.kill("SIGKILL");
      endStep(live, "length");
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
  const evidence = [...new Set([text, live.apiError?.text, live.authError].filter(Boolean))].join(" — ");
  return new ClaudeCodeFailure(evidence || `Claude Code failed${kind ? ` (${kind})` : ""}`, {
    ...(typeof status === "number" ? { status } : {}),
    ...(kind ? { code: kind, ...(ERROR_TYPES[kind] ? { type: ERROR_TYPES[kind] } : {}) } : {}),
  });
}

function stop(live: Live): void {
  if (live.finished) return;
  live.abort.abort();
  live.child?.kill("SIGKILL");
}

function fail(live: Live, error: Error): void {
  stop(live);
  if (live.failure) swallow("claude-code: later failure", error);
  else live.failure = error;
  const step = live.step;
  live.step = undefined;
  if (step) failStep(step, live.failure, false);
  else swallow("claude-code: failure held for the next step", error);
}

async function appliesUnconfiguredSettings(query: Query): Promise<boolean> {
  const report = await (query as unknown as { getSettings(): Promise<SettingsReport | undefined> }).getSettings();
  if (!Array.isArray(report?.sources)) return true;
  return report.sources.some(
    (source) => source.source !== QM_SETTINGS_SOURCE && Object.keys(source.settings ?? {}).length > 0,
  );
}

function unconfigured(what: string): ClaudeCodeFailure {
  return new ClaudeCodeFailure(
    `Claude Code ${what} that QM did not configure, most likely from the Claude account's managed settings; QM refuses to run Claude Code with them`,
    { type: "permission_error", code: "managed_settings" },
  );
}

function onMessage(live: Live, message: SDKMessage): void {
  if (message.type === "system" && message.subtype.startsWith("hook_")) {
    const hook = message as { hook_event?: string; hook_name?: string };
    console.error(`[claude-code] ${message.subtype} event=${hook.hook_event} name=${hook.hook_name}`);
    return fail(live, unconfigured(`ran a ${hook.hook_event} hook (${hook.hook_name})`));
  }
  if (message.type === "system" && message.subtype === "init") {
    const servers = message.mcp_servers.map((server) => `${server.name}=${server.status}`).join(", ");
    const foreign = message.tools.filter((name) => !live.served.has(name));
    const missing = [...live.served.keys()].filter((name) => !message.tools.includes(name));
    if (foreign.length || missing.length)
      return fail(
        live,
        new ClaudeCodeFailure(
          `Claude Code's tools differ from QM's: extra [${foreign.join(", ")}], missing [${missing.join(", ")}], MCP servers [${servers}]`,
          { type: "invalid_request_error" },
        ),
      );
    if (message.apiKeySource !== "none")
      return fail(
        live,
        new ClaudeCodeFailure(
          `Claude Code reported API key source ${message.apiKeySource}; this route only uses a subscription login`,
          { type: "permission_error" },
        ),
      );
    console.error(
      `[claude-code] query started cc=${message.claude_code_version} model=${message.model} apiKeySource=${message.apiKeySource} tools=${message.tools.length}`,
    );
    return;
  }
  if (message.type === "auth_status" && message.error) {
    live.authError = message.error;
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
      return fail(
        live,
        new ClaudeCodeFailure(
          "Claude reported that this request is drawing on extra usage (overage); the claude-code route refuses metered usage",
          { type: "invalid_request_error", code: "overage_in_use" },
        ),
      );
    return;
  }
  if (message.type === "result") {
    live.finished = true;
    live.input.end();
    if (message.subtype === "success" && !message.is_error) {
      endStep(live, "stop");
      return;
    }
    const text =
      message.subtype === "success"
        ? message.result
        : `${message.subtype}${message.terminal_reason ? ` (${message.terminal_reason})` : ""}: ${message.errors.join("; ")}`;
    fail(live, apiFailure(live, text, message.subtype === "success" ? message.api_error_status : undefined));
  }
}

function rememberAnnouncements(live: Live): void {
  if (!live.query || !live.finished) return;
  try {
    const latest = new Map<string, ImportAttachment["attachment"]>();
    const transcript = openSession({
      sessionId: live.session,
      projectPath: realpathSync(WORK_DIR),
      claudeDir: live.dir,
    });
    for (const record of transcript.attachments)
      if (ANNOUNCED.has(record.attachment.type)) latest.set(record.attachment.type, record.attachment);
    if (latest.size === ANNOUNCED.size) announcements.set(live.model.id, [...latest.values()]);
  } catch (e) {
    swallow("claude-code: reading what Claude Code announced", e);
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
    child.stderr.on("data", (data: Buffer) => console.error(`[claude-code] ${data.toString().trimEnd()}`));
    child.once("exit", live.markExited);
    child.once("error", (error) => {
      if (error.name === "AbortError") return;
      swallow("claude-code: the Claude Code process failed", error);
      if (child.pid === undefined) live.markExited();
    });
    return child as unknown as SpawnedProcess;
  };
}

async function teardown(live: Live, reason: string): Promise<void> {
  live.closed = true;
  stop(live);
  live.input.end();
  const step = live.step;
  live.step = undefined;
  if (step) failStep(step, new Error(reason), true);
  try {
    await live.query?.return(undefined);
  } catch (e) {
    swallow("claude-code: closing the query", e);
  }
  if (!live.child) live.markExited();
  await live.exited;
  rememberAnnouncements(live);
  try {
    rmSync(live.dir, { recursive: true, force: true });
  } catch (e) {
    swallow("claude-code: removing the query directory", e);
  }
}

function closeLive(live: Live, reason: string): Promise<void> {
  live.closing ??= teardown(live, reason);
  return live.closing;
}

function refusalFor(closed: boolean, token: string | undefined): ClaudeCodeFailure | undefined {
  if (closed) return new ClaudeCodeFailure("This model runtime has been closed", { type: "invalid_request_error" });
  if (!isClaudeSubscriptionToken(token))
    return new ClaudeCodeFailure(
      "Claude Code serves only a Claude subscription OAuth token; this route never uses a metered API key",
      { type: "authentication_error" },
    );
  return undefined;
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
  let connectionClosed = false;

  const bindAbort = (target: Live, signal: AbortSignal | undefined) => {
    if (!signal) return;
    if (signal.aborted) {
      void closeLive(target, "The run was aborted");
      return;
    }
    signal.addEventListener("abort", () => void closeLive(target, "The run was aborted"), { once: true });
  };

  const attach = (
    target: Live,
    step: Step,
    request: ClaudeCodeRequest,
    messages: readonly Message[],
    signal: AbortSignal | undefined,
  ) => {
    target.awaiting = [];
    if (target.failure) {
      failStep(step, target.failure, false);
      return;
    }
    const tail = messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1);
    target.step = step;
    bindAbort(target, signal);
    const steer = lastUserBlocks(request.messages).filter((block) => block.type !== "tool_result");
    if (steer.length) target.input.push(userMessage(steer));
    for (const message of tail)
      if (message.role === "toolResult") deliver(target, message.toolCallId, mcpResult(message));
  };

  const start = async (
    model: Model<Api>,
    request: ClaudeCodeRequest,
    token: string,
    step: Step,
    streamOptions: SimpleStreamOptions | undefined,
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
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "qm-claude-code-")));
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => (markExited = resolve));
    const target: Live = {
      abort: new AbortController(),
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
      session: randomUUID(),
      toolChoice: request.tool_choice,
      closed: false,
      finished: false,
    };
    live = target;
    bindAbort(target, streamOptions?.signal);
    if (target.closed) return;
    const { history, prompt } = splitPrompt(request.messages);
    const sessionId = target.session;
    if (history.length) {
      const session = createSession({ projectPath: work, claudeDir: dir, cwd: work, model: request.model, sessionId });
      const announced = announcements.get(model.id) ?? [];
      session.importMessages(history, { attachments: announced.map((attachment) => ({ afterIndex: 0, attachment })) });
      session.save();
    }
    const longest = Math.max(0, ...request.tools.map((tool) => tool.description.length));
    const wire = wireOptions(model, request);
    const options: Options = {
      abortController: target.abort,
      cwd: work,
      env: {
        ...claudeCodeEnv(token, dir, longest, request.max_tokens ?? model.maxTokens, streamOptions?.cacheRetention),
        ...wire.env,
      },
      systemPrompt: request.system,
      model: request.model,
      tools: [],
      allowedTools: [...target.served.keys()],
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      settings: { autoMemoryEnabled: false, crossSessionInbound: "refuse" },
      includePartialMessages: true,
      includeHookEvents: true,
      verbatimPrompts: true,
      extraArgs: { "disable-slash-commands": null },
      ...(request.tools.length ? { mcpServers: { [SERVER]: toolServer(request.tools, target) } } : {}),
      ...(history.length ? { resume: sessionId } : { sessionId }),
      ...wire.options,
      spawnClaudeCodeProcess: spawnTracked(target),
    };
    if (target.closed || connectionClosed) return closeLive(target, "QM ended the turn");
    target.query = sdk.query({ prompt: target.input, options });
    try {
      if (await appliesUnconfiguredSettings(target.query))
        throw unconfigured("applies settings (local managed policy or the Claude account's server-managed settings)");
      if (target.closed) return;
      target.input.push(userMessage(prompt));
      for await (const message of target.query) {
        if (target.closed) break;
        onMessage(target, message);
        if (target.failure) break;
      }
      if (!target.closed && !target.finished && !target.failure)
        throw apiFailure(target, "Claude Code ended without a result", undefined);
    } catch (error) {
      if (target.closed || target.finished) swallow("claude-code: error after the query ended", error);
      else fail(target, error instanceof ClaudeCodeFailure ? error : apiFailure(target, errMessage(error), undefined));
    } finally {
      if (target.failure || target.finished) await closeLive(target, "The Claude Code query ended");
    }
  };

  return {
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const step = newStep(stream, model);
      const token = options?.apiKey;
      const refusal = refusalFor(connectionClosed, token);
      if (refusal) {
        queueMicrotask(() => failStep(step, refusal, false));
        return stream;
      }
      const messages = transformMessages(context.messages, model, toolCallId);
      const request: ClaudeCodeRequest = {
        model: model.id,
        system: (context.systemPrompt ?? "").toWellFormed(),
        messages: claudeCodeTranscript(messages),
        tools: (context.tools ?? []).map((tool) => ({
          name: TOOL_PREFIX + tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        ...thinkingFor(model, context, options),
      };
      const continuing = continues(live, messages) ? live : undefined;
      void (async () => {
        const shaped = await options?.onPayload?.(request, model);
        const sent = sendable(shaped === undefined ? request : shaped);
        if (sent.speed === "fast")
          throw new ClaudeCodeFailure(
            "Fast mode draws on Claude extra usage, which the Claude subscription route refuses; turn fast mode off for this model",
            { type: "invalid_request_error", code: "fast_mode_unavailable" },
          );
        if (continuing && JSON.stringify(continuing.toolChoice) === JSON.stringify(sent.tool_choice))
          attach(continuing, step, sent, messages, options?.signal);
        else await start(model, sent, token!, step, options);
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
