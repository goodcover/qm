import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelGatewayTransportConfig } from "./provider-endpoints.ts";
import type { ProviderKeys } from "./model-runtime.ts";
import { CODEX_SUBSCRIPTION_PROVIDER, modelDisplayName } from "./pi-models.ts";
import { CLAUDE_CODE_PROVIDER, isClaudeSubscriptionToken } from "./claude-subscription.ts";

export type ModelBilling = "model_gateway" | "org_key" | "org_subscription" | "personal_account";

export interface ModelRoute {
  modelId: string;
  model: Model<Api>;
  keys: ProviderKeys;
  gateway?: ModelGatewayTransportConfig;
  billing: ModelBilling;
}

const BILLING_LABELS: Record<ModelBilling, string> = {
  model_gateway: "the shared model gateway",
  org_key: "the organization's own provider key",
  org_subscription: "the organization's subscription",
  personal_account: "the person's own account",
};

export function modelBilling(viaGateway: boolean, personal: boolean, subscription = false): ModelBilling {
  if (personal) return "personal_account";
  if (viaGateway) return "model_gateway";
  return subscription ? "org_subscription" : "org_key";
}

export function servedBySubscription(model: Model<Api>, keys: ProviderKeys): boolean {
  return (
    model.provider === CODEX_SUBSCRIPTION_PROVIDER ||
    model.provider === CLAUDE_CODE_PROVIDER ||
    (model.provider === "anthropic" && isClaudeSubscriptionToken(keys.anthropic))
  );
}

export function routeLabel(route: Pick<ModelRoute, "modelId" | "billing">): string {
  return `${modelDisplayName(route.modelId)} (billed to ${BILLING_LABELS[route.billing]})`;
}
