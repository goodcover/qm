import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { QmModelRuntime } from "../model/model-runtime.ts";
import type { ToolContextRef } from "./agent-tools.ts";

export interface TurnSession {
  agentSession: AgentSession;
  ref: ToolContextRef & { effortLevel?: string };
  composedPromptTokens: number;
  modelRuntime: QmModelRuntime;
  agentDir: string;
  ephemeralCwd?: string;
}
