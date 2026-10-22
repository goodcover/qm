import assert from "node:assert/strict";
import { test } from "node:test";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import {
  createKeychain,
  type KeychainCredential,
  type KeychainGrant,
  type KeychainAsk,
} from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { keychainCompanyChatGPTAuth } from "../src/model/company-chatgpt-auth.ts";

const databaseUrl = process.env.DATABASE_URL;

test(
  "separate Postgres-backed company auth instances rotate one shared login once",
  { skip: databaseUrl ? false : "set DATABASE_URL for cross-instance ChatGPT refresh" },
  async () => {
    const maps = [createPostgresMapFactory(databaseUrl!), createPostgresMapFactory(databaseUrl!)];
    const locks = maps.map(({ pool }) => createPostgresAdvisoryLock(pool, { pollMs: 10 }));
    const keychains = maps.map((factory, index) =>
      createKeychain({
        creds: factory.map<KeychainCredential>("company_auth_creds"),
        grants: factory.map<KeychainGrant>("company_auth_grants"),
        asks: factory.map<KeychainAsk>("company_auth_asks"),
        key: deriveConnectorKey("synthetic-postgres-company-key"),
        lock: locks[index]!,
      }),
    );
    const jwt = (exp: number) =>
      `e30.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: "shared-account" } })).toString("base64url")}.test`;
    const extra = {
      path: ".codex/config.toml",
      contentBase64: Buffer.from("synthetic preserved config").toString("base64"),
      mode: 0o600,
    };
    try {
      const saved = await keychains[0]!.save({
        ownerId: "shared-owner",
        service: "qm-default-chatgpt",
        accountLabel: "Shared subscription",
        files: [
          {
            path: ".codex/auth.json",
            contentBase64: Buffer.from(
              JSON.stringify({
                auth_mode: "chatgpt",
                tokens: { access_token: jwt(1), refresh_token: "original-refresh" },
              }),
            ).toString("base64"),
          },
          extra,
        ],
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let calls = 0;
      const fresh = jwt(Math.floor(Date.now() / 1000) + 3600);
      const auths = keychains.map((keychain, index) =>
        keychainCompanyChatGPTAuth({
          keychain,
          lock: locks[index]!,
          credentialId: saved.id,
          refresh: async (token) => {
            calls++;
            assert.equal(token, "original-refresh");
            entered.resolve();
            await release.promise;
            return { accessToken: fresh, refreshToken: "rotated-refresh" };
          },
        }),
      );
      const first = auths[0]!.accessToken();
      await entered.promise;
      const second = auths[1]!.accessToken();
      release.resolve();
      assert.deepEqual(await Promise.all([first, second]), [fresh, fresh]);
      assert.equal(calls, 1);
      const bundle = (await keychains[1]!.materializeOwnFiles(saved.ownerId))[0]!;
      assert.deepEqual(
        bundle.files.find((file) => file.path === extra.path),
        extra,
      );
      assert.equal((await keychains[1]!.getCredential(saved.id))?.accountLabel, saved.accountLabel);
      const stored = JSON.parse(
        Buffer.from(bundle.files.find((file) => file.path === ".codex/auth.json")!.contentBase64, "base64").toString(
          "utf8",
        ),
      ) as { tokens: { refresh_token: string } };
      assert.equal(stored.tokens.refresh_token, "rotated-refresh");
    } finally {
      await Promise.all(maps.map(({ pool }) => pool.close()));
    }
  },
);
