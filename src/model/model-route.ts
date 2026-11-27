import type { Api, Model } from "@earendil-works/pi-ai";
import {
  ANTIGRAVITY_PROVIDER,
  modelGatewayRequest,
  providerBaseUrl,
  type ModelGatewayTransportConfig,
} from "./provider-endpoints.ts";
import type { ProviderKeys } from "./model-runtime.ts";
import {
  auxiliaryModelFor,
  CODEX_SUBSCRIPTION_PROVIDER,
  DEFAULT_AGENT_MODEL_ID,
  defaultModel,
  getRequiredModel,
  modelDisplayName,
  personalModelId,
  resolveModel,
} from "./pi-models.ts";
import { CLAUDE_CODE_KEY, isClaudeSubscriptionToken } from "./claude-subscription.ts";
import type { RuntimeChoice } from "../agent/agent.ts";
import { baseModelProviders, configuredModel, type Config } from "../config.ts";
import { swallow } from "../util/errors.ts";

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
  org_key: "the organization's own provider key or subscription",
  org_subscription: "the organization's subscription",
  personal_account: "the person's own account",
};

export function modelBilling(viaGateway: boolean, personal: boolean, subscription = false): ModelBilling {
  if (personal) return "personal_account";
  if (viaGateway) return "model_gateway";
  return subscription ? "org_subscription" : "org_key";
}

export function companyRouteKeys(keys: ProviderKeys): ProviderKeys {
  return {
    ...keys,
    [CLAUDE_CODE_KEY]:
      isClaudeSubscriptionToken(keys.anthropic) && !providerBaseUrl("anthropic") ? keys.anthropic : undefined,
  };
}

function servedBySubscription(model: Model<Api>, keys: ProviderKeys): boolean {
  return (
    model.provider === CODEX_SUBSCRIPTION_PROVIDER ||
    model.provider === ANTIGRAVITY_PROVIDER ||
    (model.provider === "anthropic" && isClaudeSubscriptionToken(keys.anthropic))
  );
}

export function routeLabel(route: Pick<ModelRoute, "modelId" | "billing">): string {
  return `${modelDisplayName(route.modelId)} (billed to ${BILLING_LABELS[route.billing]})`;
}

export function resolveConfiguredModelId(configured: string | undefined, defaultModelId?: string): string {
  for (const candidate of [configured, defaultModelId]) {
    if (!candidate) continue;
    if (resolveModel(candidate)) return candidate;
    swallow("pi: configured model id not in registry, falling back to default", new Error(candidate));
  }
  return DEFAULT_AGENT_MODEL_ID;
}

export interface ModelRouteOptions {
  modelId?: string;
  defaultModelId?: string;
  resolveBaseModelId?: () => string | undefined;
  resolveFallbackRuntime?: () => RuntimeChoice | undefined;
  companyModelId?: (id: string) => string;
  apiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  modelGateway?: ModelGatewayTransportConfig;
  resolveProviderKeys?: () => Promise<ProviderKeys>;
}

export function configRouteOptions(config: Config): ModelRouteOptions {
  const defaultModelId =
    configuredModel(config) ?? (config.modelProvider ? defaultModel(undefined, baseModelProviders(config)) : undefined);
  return {
    ...(defaultModelId ? { defaultModelId } : {}),
    ...(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {}),
    ...(config.openaiApiKey ? { openaiApiKey: config.openaiApiKey } : {}),
    ...(config.openrouterApiKey ? { openrouterApiKey: config.openrouterApiKey } : {}),
    ...(config.modelGateway ? { modelGateway: config.modelGateway } : {}),
  };
}

export interface ModelRoutes {
  readonly gateway?: ModelGatewayTransportConfig;
  baseModelId(): string;
  utilityModelId(override?: string): string;
  servedId(id: string, personalKeys?: ProviderKeys): string;
  route(modelId: string, personalKeys?: ProviderKeys): Promise<ModelRoute>;
  servable(route: ModelRoute): ModelRoute | undefined;
  session(session: { runtime?: { modelId?: string }; providerKeys?: ProviderKeys }): Promise<ModelRoute>;
  utility(modelId?: string): Promise<ModelRoute | undefined>;
  fallback(
    from: ModelRoute,
    fromModelIds: ReadonlySet<string>,
    providerKeys?: ProviderKeys,
  ): Promise<(ModelRoute & { runtime: RuntimeChoice }) | undefined>;
}

export function createModelRoutes(opts: ModelRouteOptions = {}): ModelRoutes {
  const baseModelId = () => resolveConfiguredModelId(opts.resolveBaseModelId?.() ?? opts.modelId, opts.defaultModelId);
  const staticKeys: ProviderKeys = opts.resolveProviderKeys
    ? {}
    : {
        ...(opts.apiKey ? { anthropic: opts.apiKey } : {}),
        ...(opts.openaiApiKey ? { openai: opts.openaiApiKey } : {}),
        ...(opts.openrouterApiKey ? { openrouter: opts.openrouterApiKey } : {}),
      };
  const companyKeys = async (): Promise<ProviderKeys> => ({
    ...staticKeys,
    ...(await opts.resolveProviderKeys?.()),
  });
  const companyServedId = (id: string) => (opts.companyModelId ? opts.companyModelId(id) : id);
  const servedId = (id: string, personalKeys?: ProviderKeys) =>
    personalKeys ? personalModelId(id, personalKeys) : companyServedId(id);
  const route = async (requestedId: string, personalKeys?: ProviderKeys): Promise<ModelRoute> => {
    const modelId = personalKeys ? personalModelId(requestedId, personalKeys) : requestedId;
    const model = getRequiredModel(personalKeys ? modelId : companyServedId(modelId), !personalKeys);
    const keys = personalKeys ?? companyRouteKeys(await companyKeys());
    const gateway = personalKeys ? undefined : opts.modelGateway;
    return {
      modelId,
      model,
      keys,
      ...(gateway ? { gateway } : {}),
      billing: modelBilling(!!modelGatewayRequest(gateway, model), !!personalKeys, servedBySubscription(model, keys)),
    };
  };
  const servable = (r: ModelRoute): ModelRoute | undefined =>
    r.billing === "model_gateway" || r.keys[String(r.model.provider)] ? r : undefined;
  const utilityModelId = (override?: string) => override ?? auxiliaryModelFor(baseModelId());
  return {
    ...(opts.modelGateway ? { gateway: opts.modelGateway } : {}),
    baseModelId,
    utilityModelId,
    servedId,
    route,
    servable,
    session: (session) => route(session.runtime?.modelId ?? baseModelId(), session.providerKeys),
    utility: async (modelId) => servable(await route(utilityModelId(modelId))),
    async fallback(from, fromModelIds, providerKeys) {
      const runtime = opts.resolveFallbackRuntime?.();
      if (!runtime) return undefined;
      const served = servedId(runtime.modelId, providerKeys);
      if (fromModelIds.has(runtime.modelId) || fromModelIds.has(served) || !resolveModel(served, !providerKeys))
        return undefined;
      const r = servable(await route(runtime.modelId, providerKeys));
      if (r && from.billing === "org_subscription" && r.billing !== "org_subscription") {
        console.error(
          `[pi] fallback ${routeLabel(r)} skipped: ${routeLabel(from)} may only fall back to another subscription`,
        );
        return undefined;
      }
      return r && { ...r, runtime };
    },
  };
}
