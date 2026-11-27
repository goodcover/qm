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
import type { ChildProcess } from "node:child_process";
import { asError, errMessage, swallow } from "../util/errors.ts";
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

export interface HarnessLive<S extends HarnessStep = HarnessStep> {
  step?: S;
  handedOut: string[];
  failure?: Error;
  closed: boolean;
  done: boolean;
  closing?: Promise<void>;
}

export function refuseUnsent(label: string, unsent: readonly string[]): void {
  if (unsent.length)
    throw new HarnessFailure(`${label} cannot send request fields QM's request hook set: ${unsent.join(", ")}`, {
      type: "invalid_request_error",
    });
}

export function holdFailure<S extends HarnessStep>(
  label: string,
  live: HarnessLive<S>,
  error: Error,
  end: (step: S, failure: Error) => void = (step, failure) => failStep(step, failure, false),
): void {
  if (live.failure) swallow(`${label}: later failure`, error);
  else live.failure = error;
  const step = live.step;
  live.step = undefined;
  if (step) end(step, live.failure);
  else swallow(`${label}: failure held for the next step`, error);
}

export interface ProcessExit {
  started: boolean;
  how: string;
}

export function trackProcess(
  label: string,
  child: ChildProcess,
  cleanup: () => void = () => undefined,
): Promise<ProcessExit> {
  child.stderr?.on("data", (data: Buffer) => console.error(`[${label}] ${data.toString().trimEnd()}`));
  return new Promise<ProcessExit>((resolve) => {
    const done = (started: boolean, how: string) => {
      cleanup();
      resolve({ started, how });
    };
    child.once("exit", (code, signal) => done(true, signal ? `was killed by ${signal}` : `exited with code ${code}`));
    child.once("error", (error) => {
      if (child.pid === undefined) done(false, `could not start: ${errMessage(error)}`);
      else if (error.name !== "AbortError") swallow(`${label}: the process reported an error`, error);
    });
  });
}

export function harnessSlot<L extends HarnessLive>(
  label: string,
  closeLive: (live: L, reason: string) => Promise<void>,
  fail: (live: L, error: Error) => void,
) {
  let current: L | undefined;
  let closed = false;
  return {
    get current(): L | undefined {
      return current;
    },
    get closed(): boolean {
      return closed;
    },
    bindAbort(live: L, signal: AbortSignal | undefined): void {
      const abort = () => void closeLive(live, "The run was aborted");
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    },
    async supersede(): Promise<void> {
      const previous = current;
      current = undefined;
      if (previous) await closeLive(previous, "Superseded by a new request");
    },
    adopt(live: L): void {
      current = live;
    },
    run(
      step: HarnessStep,
      refusal: Error | undefined,
      work: () => Promise<void>,
      failure: (error: unknown) => Error = asError,
    ): void {
      const refused = closed
        ? new HarnessFailure("This model runtime has been closed", { type: "invalid_request_error" })
        : refusal;
      if (refused) {
        queueMicrotask(() => failStep(step, refused, false));
        return;
      }
      work().catch((error: unknown) => {
        const reason = failure(error);
        if (current?.step === step) fail(current, reason);
        else if (!step.output.errorMessage) failStep(step, reason, false);
        else swallow(`${label}: failure after the step ended`, reason);
      });
    },
    async close(): Promise<void> {
      closed = true;
      const previous = current;
      current = undefined;
      if (previous) await closeLive(previous, "QM ended the turn");
    },
  };
}

export function afterLastAssistant(messages: readonly Message[]): readonly Message[] {
  return messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1);
}

export function continues<L extends HarnessLive>(live: L | undefined, messages: readonly Message[]): live is L {
  if (!live || live.step || !live.handedOut.length || (!live.failure && (live.closed || live.done))) return false;
  const assistant = messages.findLast((message) => message.role === "assistant");
  const calls = assistant?.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) ?? [];
  if (calls.length !== live.handedOut.length || calls.some((id, i) => id !== live.handedOut[i])) return false;
  const answered = new Set(
    afterLastAssistant(messages).flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
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
