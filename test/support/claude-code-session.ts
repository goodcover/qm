import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { buildModelRuntime, type ProviderKeys } from "../../src/model/model-runtime.ts";
import { routeKeys } from "../../src/model/model-route.ts";
import type { ModelGatewayTransportConfig } from "../../src/model/provider-endpoints.ts";
import { resolveModel } from "../../src/model/pi-models.ts";

export const CLAUDE_CODE_TEST_MODEL = "claude-code/claude-sonnet-5";

export const CLAUDE_CODE_TEST_SYSTEM =
  "You are QM, the org's agent. Org guidance: never share salaries. User guidance: answer tersely.";

export function lookupTool(executed: string[], terminate = false): ToolDefinition {
  return {
    name: "lookup",
    label: "Lookup",
    description: "Look up one record by key. Returns the record text.",
    parameters: Type.Object({ key: Type.String({ description: "Record key" }) }),
    async execute(_id, params) {
      const { key } = params as { key: string };
      executed.push(key);
      return {
        content: [{ type: "text", text: `record ${key}` }],
        details: {},
        ...(terminate ? { terminate } : {}),
      };
    },
  };
}

export async function claudeCodeSession(
  keys: ProviderKeys,
  tools: ToolDefinition[],
  messages: Message[] = [],
  { modelId = CLAUDE_CODE_TEST_MODEL, gateway }: { modelId?: string; gateway?: ModelGatewayTransportConfig } = {},
): Promise<{ session: AgentSession; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-session-test-"));
  const model = resolveModel(modelId)!;
  const runtime = await buildModelRuntime(routeKeys(model, keys), gateway);
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    systemPrompt: CLAUDE_CODE_TEST_SYSTEM,
    appendSystemPrompt: [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    model,
    modelRuntime: runtime,
    resourceLoader,
    settingsManager,
    customTools: tools,
    noTools: "builtin",
    sessionManager: SessionManager.inMemory(),
    cwd: dir,
    agentDir: dir,
  });
  if (messages.length) session.agent.state.messages = [...messages];
  return { session, close: () => runtime.close() };
}

export function lastAssistant(session: AgentSession): AssistantMessage {
  return session.messages.findLast((message) => message.role === "assistant") as AssistantMessage;
}
