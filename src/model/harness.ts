import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  ProviderErrorInfo,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { errMessage } from "../util/errors.ts";
import { zeroUsage } from "./model-runtime.ts";

export const RESUMED_AT_TOOL_RESULTS = "[system] The run resumed after the tool results above. Continue the task.";

export class HarnessFailure extends Error {
  readonly providerError: ProviderErrorInfo;
  constructor(message: string, providerError: ProviderErrorInfo) {
    super(message);
    this.providerError = providerError;
  }
}

export interface ServedTool {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface HarnessStep {
  stream: AssistantMessageEventStream;
  output: AssistantMessage;
  started: boolean;
}

export function harnessOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function startStep(step: HarnessStep): void {
  if (step.started) return;
  step.started = true;
  step.stream.push({ type: "start", partial: step.output });
}

export function finishStep(step: HarnessStep, reason: "stop" | "length" | "toolUse"): void {
  startStep(step);
  step.output.stopReason = reason;
  step.stream.push({ type: "done", reason, message: step.output });
  step.stream.end();
}

export function failStep(step: HarnessStep, error: Error, aborted: boolean): void {
  step.output.stopReason = aborted ? "aborted" : "error";
  step.output.errorMessage = errMessage(error);
  if (error instanceof HarnessFailure) step.output.providerError = error.providerError;
  step.stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: step.output });
  step.stream.end();
}

export function onAbort(signal: AbortSignal | undefined, abort: () => void): void {
  if (!signal) return;
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
}

export function answersToolCalls(messages: readonly Message[], handedOut: readonly string[]): boolean {
  const last = messages.findLastIndex((message) => message.role === "assistant");
  const assistant = messages[last] as AssistantMessage | undefined;
  const calls = assistant?.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) ?? [];
  if (calls.length !== handedOut.length || calls.some((id, i) => id !== handedOut[i])) return false;
  const answered = new Set(
    messages.slice(last + 1).flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
  );
  return calls.every((id) => answered.has(id));
}

export function mcpResult(result: ToolResultMessage): CallToolResult {
  return {
    content: result.content.map((block) =>
      block.type === "text"
        ? { type: "text" as const, text: block.text.toWellFormed() }
        : { type: "image" as const, data: block.data, mimeType: block.mimeType },
    ),
    ...(result.isError ? { isError: true } : {}),
  };
}

export function qmToolServer(
  name: string,
  tools: ReadonlyArray<{ name: string; description: string; inputSchema: unknown; _meta: Record<string, unknown> }>,
  call: (request: CallToolRequest) => CallToolResult | Promise<CallToolResult>,
): McpServer {
  const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({ ...tool, inputSchema: tool.inputSchema as { type: "object" } })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, call);
  return server;
}
