import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { rm } from "node:fs/promises";
import * as pi from "../src/harness/pi-harness.ts";
import type { Harness } from "../src/harness/harness.ts";
import { hashId } from "../src/util/crypto.ts";
import { testConfig } from "./support/test-config.ts";

let harness: Harness;
mock.module("../src/harness/pi-harness.ts", {
  namedExports: {
    ...pi,
    createPiHarness: (options: pi.PiHarnessOptions) => {
      harness = pi.createPiHarness(options);
      return harness;
    },
  },
});

const { buildApp } = await import("../src/wiring.ts");
const ownerId = "subscription-owner";
const service = "qm-default-chatgpt";
const credentialId = hashId([ownerId, service, "file"]);
const accountId = "subscription-account";
const token = (exp: number) =>
  `e30.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.test`;

for (const modelId of ["gpt-5.6-sol", "gpt-6.1-sol", "codex/gpt-6.1-sol"]) {
  test(`company wiring reuses the existing file login through Pi for ${modelId}`, async (t) => {
    const config = testConfig({
      harness: "pi",
      modelId,
      codexAuthCredential: credentialId,
      openaiApiKey: "synthetic-metered-key",
    });
    const built = buildApp(config);
    t.after(async () => {
      built.mcpToolService.close();
      await rm(config.dataDir, { recursive: true, force: true });
    });
    const accessToken = token(Math.floor(Date.now() / 1000) + 3600);
    const saved = await built.keychain!.save({
      ownerId,
      service,
      files: [
        {
          path: ".codex/auth.json",
          contentBase64: Buffer.from(
            JSON.stringify({
              auth_mode: "chatgpt",
              tokens: { access_token: accessToken, refresh_token: "synthetic-refresh", account_id: accountId },
            }),
          ).toString("base64"),
        },
      ],
    });
    assert.equal(saved.id, credentialId);
    const urls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ error: { message: "offline subscription response" } }), { status: 400 });
    });
    await assert.rejects(harness.models.oneShot!("system", "hello"), /offline subscription response/);
    assert.ok(urls.length > 0);
    assert.ok(urls.every((url) => new URL(url).hostname === "chatgpt.com"));
    await built.keychain!.remove(ownerId, credentialId);
    urls.length = 0;
    assert.equal(await harness.models.oneShot!("system", "hello"), undefined);
    assert.deepEqual(urls, []);
  });
}

for (const modelId of ["gpt-6-astra-ultrafast", "gpt-6.1-sol-ultrafast"]) {
  test(`company subscription wiring never sends API-only ${modelId} to a metered provider`, async (t) => {
    const config = testConfig({
      harness: "pi",
      modelId,
      codexAuthCredential: credentialId,
      openaiApiKey: "synthetic-metered-key",
    });
    const built = buildApp(config);
    t.after(async () => {
      built.mcpToolService.close();
      await rm(config.dataDir, { recursive: true, force: true });
    });
    const fetches = t.mock.method(globalThis, "fetch", async () =>
      assert.fail("must fail before any provider request"),
    );
    await assert.rejects(harness.models.oneShot!("system", "hello"), /Unsupported model: codex\//);
    assert.equal(fetches.mock.callCount(), 0);
  });
}

test("company Pi wiring refreshes and rotates the existing saved ChatGPT login without API fallback", async (t) => {
  const config = testConfig({
    harness: "pi",
    modelId: "codex/gpt-6.1-sol",
    codexAuthCredential: credentialId,
    openaiApiKey: "synthetic-metered-key",
  });
  const built = buildApp(config);
  t.after(async () => {
    built.mcpToolService.close();
    await rm(config.dataDir, { recursive: true, force: true });
  });
  const auth = {
    auth_mode: "chatgpt",
    tokens: { access_token: token(1), refresh_token: "synthetic-original", account_id: accountId },
  };
  await built.keychain!.save({
    ownerId,
    service,
    files: [{ path: ".codex/auth.json", contentBase64: Buffer.from(JSON.stringify(auth)).toString("base64") }],
  });
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (url === "https://auth.openai.com/oauth/token") {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      assert.equal(body.grant_type, "refresh_token");
      assert.equal(body.refresh_token, "synthetic-original");
      return Response.json({
        access_token: token(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: "synthetic-rotated",
        expires_in: 3600,
      });
    }
    assert.equal(new URL(url).hostname, "chatgpt.com");
    return Response.json({ error: { message: "offline refreshed subscription response" } }, { status: 400 });
  });
  await assert.rejects(harness.models.oneShot!("system", "hello"), /offline refreshed subscription response/);
  assert.equal(urls.filter((url) => url === "https://auth.openai.com/oauth/token").length, 1);
  const files = (await built.keychain!.materializeOwnFiles(ownerId)).find(
    (bundle) => bundle.credentialId === credentialId,
  )!.files;
  const stored = JSON.parse(Buffer.from(files[0]!.contentBase64, "base64").toString("utf8")) as typeof auth;
  assert.equal(stored.tokens.refresh_token, "synthetic-rotated");
  assert.equal(stored.tokens.account_id, accountId);
  assert.equal((await built.keychain!.getCredential(credentialId))?.service, service);
});
