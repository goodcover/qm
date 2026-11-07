const CLAUDE_SUBSCRIPTION_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];
const CLAUDE_CODE_CLIENT = "claude-cli/2.1.280";

export function isClaudeSubscriptionToken(key: string | undefined): boolean {
  return Boolean(key?.includes("sk-ant-oat"));
}

export function claudeSubscriptionBetas(key: string | undefined): readonly string[] {
  return isClaudeSubscriptionToken(key) ? CLAUDE_SUBSCRIPTION_BETAS : [];
}

export function claudeSubscriptionHeaders(key: string | undefined): Record<string, string> {
  return isClaudeSubscriptionToken(key) ? { "user-agent": CLAUDE_CODE_CLIENT } : {};
}
