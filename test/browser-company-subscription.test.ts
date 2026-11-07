import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { serverDeps } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, BROWSER_MODEL_AUD } from "../src/auth/capability-token.ts";
import { hashId } from "../src/util/crypto.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";

const ownerId = "company-owner";
const service = "qm-default-chatgpt";
const credentialId = hashId([ownerId, service, "file"]);
const model = "gpt-5.6-sol";
const accessToken = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "company-account" } })).toString("base64url")}.test`;

for (const gateway of [false, true]) {
  test(`company browsing retains ChatGPT subscription access beside a Claude subscription with gateway=${gateway}`, async (t) => {
    const config = testConfig({
      codexAuthCredential: credentialId,
      claudeAuthCredential: "synthetic-claude-reference",
      openaiApiKey: "synthetic-metered-key",
      signingSecret: "synthetic-browser-signing-key-0123456789",
    });
    const built = buildApp(config);
    await built.config.setRuntimeSelection("personal:U1", { modelId: model });
    await built.keychain!.save({
      ownerId,
      service,
      files: [
        {
          path: ".codex/auth.json",
          contentBase64: Buffer.from(
            JSON.stringify({
              auth_mode: "chatgpt",
              tokens: { access_token: accessToken, refresh_token: "synthetic-refresh" },
            }),
          ).toString("base64"),
        },
      ],
    });
    const server = createServer(built.app, {
      ...serverDeps(config, built),
      ...(gateway
        ? {
            modelGatewayTransport: {
              url: "https://gateway.example.test/v1",
              apiKey: "synthetic-gateway-key",
              apiKeyHeader: "Authorization",
              models: { [model]: "metered-model", [`codex/${model}`]: "metered-model" },
            },
          }
        : {}),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      built.mcpToolService.close();
      await rm(config.dataDir, { recursive: true, force: true });
    });
    const token = await mintCapabilityToken(
      {
        actorId: "U1",
        scopeId: "personal:U1",
        browserModel: model,
        browserAccount: "company",
        aud: BROWSER_MODEL_AUD,
        exp: Date.now() + 60_000,
      },
      TEST_CAPABILITY_SECRET,
    );
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/browser-model/chat/completions`;
    const originalFetch = globalThis.fetch;
    const providerUrls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === endpoint) return originalFetch(input, init);
      providerUrls.push(url);
      return Response.json({ error: { message: "offline subscription response" } }, { status: 400 });
    });
    const post = () =>
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-capability": token },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
      });
    const first = await post();
    assert.equal(first.status, 502);
    await first.arrayBuffer();
    assert.ok(providerUrls.length > 0);
    assert.ok(providerUrls.every((url) => new URL(url).hostname === "chatgpt.com"));
    await built.keychain!.remove(ownerId, credentialId);
    providerUrls.length = 0;
    const missing = await post();
    assert.equal(missing.status, 503);
    await missing.arrayBuffer();
    assert.deepEqual(providerUrls, []);
  });
}
