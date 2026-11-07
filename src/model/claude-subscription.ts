export const CLAUDE_CODE_PROVIDER = "claude-code";
export const CLAUDE_CODE_PREFIX = "claude-code/";

export function claudeCodeNativeId(id: string): string {
  return id.slice(CLAUDE_CODE_PREFIX.length);
}

const CLAUDE_SUBSCRIPTION_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];

export function isClaudeSubscriptionToken(key: string | undefined): boolean {
  return Boolean(key?.startsWith("sk-ant-oat"));
}

export function claudeSubscriptionBetas(key: string | undefined): readonly string[] {
  return isClaudeSubscriptionToken(key) ? CLAUDE_SUBSCRIPTION_BETAS : [];
}
