import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { testAdvisoryLock, testMap } from "./support/test-database.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { chatgptAuthFromValue } from "../src/model/chatgpt-auth-file.ts";
import { keychainCompanyChatGPTAuth } from "../src/model/company-chatgpt-auth.ts";
import {
  createKeychain,
  type CredentialFile,
  type Keychain,
  type KeychainCredentialMeta,
} from "../src/credentials/keychain.ts";
import type { UserOAuthTokens } from "../src/model/user-model-credential-store.ts";

function jwt(payload: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(payload)}.sig`;
}

function idToken(accountId: string): string {
  return jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
}

function accessToken(accountId: string, expSec: number, marker = "a"): string {
  return jwt({ exp: expSec, marker, "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
}

function authJson(accountId: string, expSec: number, refreshToken = "refresh-1"): Record<string, unknown> {
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: accessToken(accountId, expSec),
      refresh_token: refreshToken,
      id_token: idToken(accountId),
      account_id: accountId,
    },
  };
}

const NOW = 1_900_000_000_000;
const FRESH_EXP = Math.floor(NOW / 1000) + 3600;
const STALE_EXP = Math.floor(NOW / 1000) + 60;

interface FakeKeychainState {
  meta: KeychainCredentialMeta;
  files: CredentialFile[];
  saves: Array<{ ownerId: string; service: string; files?: CredentialFile[] }>;
  materializations: number;
}

function fakeKeychain(state: FakeKeychainState): Keychain {
  return {
    async getCredential(id: string) {
      return id === state.meta.id ? state.meta : null;
    },
    async materializeOwnFiles(ownerId: string) {
      state.materializations += 1;
      if (ownerId !== state.meta.ownerId) return [];
      return [{ credentialId: state.meta.id, ownerId, service: state.meta.service, files: state.files }];
    },
    async updateFiles(
      materialized: { ownerId: string; service: string; files: CredentialFile[]; writeback?: boolean },
      files: CredentialFile[],
    ) {
      if (!materialized.writeback) return;
      state.saves.push({ ownerId: materialized.ownerId, service: materialized.service, files });
      state.files = files;
      state.meta = { ...state.meta, fingerprint: `f${state.saves.length}`, updatedAt: state.saves.length };
      return state.meta;
    },
  } as unknown as Keychain;
}

function credFiles(auth: Record<string, unknown>): CredentialFile[] {
  return [{ path: ".codex/auth.json", contentBase64: Buffer.from(JSON.stringify(auth)).toString("base64") }];
}

function keychainState(auth: Record<string, unknown>): FakeKeychainState {
  return {
    meta: {
      id: "cred-1",
      ownerId: "owner@example.com",
      service: "codex-chatgpt",
      kind: "file",
      fingerprint: "f0",
      createdAt: 0,
      updatedAt: 0,
    } as KeychainCredentialMeta,
    files: credFiles(auth),
    saves: [],
    materializations: 0,
  };
}

function refreshTo(accountId: string, refreshToken = "refresh-2") {
  const calls: string[] = [];
  const refresh = async (token: string): Promise<UserOAuthTokens> => {
    calls.push(token);
    return {
      accessToken: accessToken(accountId, FRESH_EXP, "refreshed"),
      idToken: idToken(accountId),
      refreshToken,
    };
  };
  return { calls, refresh };
}

test("chatgptAuthFromValue validates shape and account binding", () => {
  assert.ok(chatgptAuthFromValue(authJson("acct", FRESH_EXP)));
  assert.equal(chatgptAuthFromValue({ auth_mode: "apikey" }), null);
  const missingRefresh = authJson("acct", FRESH_EXP);
  delete (missingRefresh.tokens as Record<string, unknown>).refresh_token;
  assert.equal(chatgptAuthFromValue(missingRefresh), null);
});

test("keychain auth serves a fresh token without refreshing and caches the decrypted credential", async () => {
  const state = keychainState(authJson("acct", FRESH_EXP));
  const auth = keychainCompanyChatGPTAuth({
    lock: testAdvisoryLock(),
    keychain: fakeKeychain(state),
    credentialId: "cred-1",
    now: () => NOW,
    refresh: async () => assert.fail("must not refresh"),
  });
  assert.equal(await auth.accessToken(), accessToken("acct", FRESH_EXP));
  assert.equal(await auth.accessToken(), accessToken("acct", FRESH_EXP));
  assert.equal(state.materializations, 1);
  assert.equal(state.saves.length, 0);
  state.files = credFiles(authJson("acct", FRESH_EXP, "replaced"));
  state.meta = { ...state.meta, fingerprint: "re-registered", updatedAt: 5 };
  await auth.accessToken();
  assert.equal(state.materializations, 2);
});

test("keychain auth refreshes a stale token centrally and persists the rotation once", async () => {
  const state = keychainState(authJson("acct", STALE_EXP, "refresh-1"));
  const { calls, refresh } = refreshTo("acct");
  const auth = keychainCompanyChatGPTAuth({
    lock: testAdvisoryLock(),
    keychain: fakeKeychain(state),
    credentialId: "cred-1",
    now: () => NOW,
    refresh,
  });
  const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
  assert.equal(a, accessToken("acct", FRESH_EXP, "refreshed"));
  assert.equal(b, a);
  assert.deepEqual(calls, ["refresh-1"]);
  assert.equal(state.saves.length, 1);
  const persisted = JSON.parse(Buffer.from(state.saves[0]!.files![0]!.contentBase64, "base64").toString("utf8")) as {
    tokens: Record<string, unknown>;
  };
  assert.equal(persisted.tokens.refresh_token, "refresh-2");
  assert.equal(await auth.accessToken(), a);
  assert.equal(calls.length, 1);
});

test("keychain auth refuses a refresh that switches ChatGPT accounts", async () => {
  const state = keychainState(authJson("acct", STALE_EXP));
  const { refresh } = refreshTo("other-acct");
  const auth = keychainCompanyChatGPTAuth({
    lock: testAdvisoryLock(),
    keychain: fakeKeychain(state),
    credentialId: "cred-1",
    now: () => NOW,
    refresh,
  });
  assert.equal(await auth.accessToken(), accessToken("acct", STALE_EXP));
  assert.equal(state.saves.length, 0);
});

test("keychain auth is unavailable when the credential is missing", async () => {
  const state = keychainState(authJson("acct", FRESH_EXP));
  const auth = keychainCompanyChatGPTAuth({
    lock: testAdvisoryLock(),
    keychain: fakeKeychain(state),
    credentialId: "other",
    now: () => NOW,
  });
  assert.equal(await auth.accessToken(), undefined);
});

async function durableAuthFixture() {
  const lock = testAdvisoryLock();
  const keychain = createKeychain({
    creds: testMap(),
    grants: testMap(),
    asks: testMap(),
    key: deriveConnectorKey("synthetic-company-auth-regression-key"),
    lock,
    now: () => NOW,
  });
  const extra = {
    path: ".codex/config.toml",
    contentBase64: Buffer.from("synthetic config").toString("base64"),
    mode: 0o600,
  };
  const saved = await keychain.save({
    ownerId: "company-owner",
    service: "qm-default-chatgpt",
    files: [...credFiles(authJson("acct", STALE_EXP)), extra],
    accountLabel: "Company subscription",
    origin: "login:company",
    expiresAt: NOW + 60_000,
  });
  return {
    keychain,
    lock,
    saved,
    extra,
    make: (refresh: (token: string) => Promise<UserOAuthTokens>) =>
      keychainCompanyChatGPTAuth({ keychain, lock, credentialId: saved.id, now: () => NOW, refresh }),
  };
}

test("independent company auth instances share one refresh and preserve the full credential bundle and metadata", async () => {
  const fixture = await durableAuthFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const refresh = refreshTo("acct");
  const refreshing = async (token: string) => {
    entered.resolve();
    await release.promise;
    return refresh.refresh(token);
  };
  const a = fixture.make(refreshing).accessToken();
  await entered.promise;
  const b = fixture.make(refreshing).accessToken();
  release.resolve();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first, accessToken("acct", FRESH_EXP, "refreshed"));
  assert.equal(second, first);
  assert.deepEqual(refresh.calls, ["refresh-1"]);
  const bundle = (await fixture.keychain.materializeOwnFiles(fixture.saved.ownerId))[0]!;
  assert.deepEqual(
    bundle.files.find((file) => file.path === fixture.extra.path),
    fixture.extra,
  );
  const meta = (await fixture.keychain.getCredential(fixture.saved.id))!;
  assert.equal(meta.accountLabel, fixture.saved.accountLabel);
  assert.equal(meta.origin, fixture.saved.origin);
  assert.equal(meta.createdAt, fixture.saved.createdAt);
  assert.deepEqual(meta.targets, fixture.saved.targets);
});

test("a company refresh cannot recreate a login removed while the provider request was pending", async () => {
  const fixture = await durableAuthFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const running = fixture
    .make(async () => {
      entered.resolve();
      await release.promise;
      return refreshTo("acct").refresh("refresh-1");
    })
    .accessToken();
  await entered.promise;
  await fixture.keychain.remove(fixture.saved.ownerId, fixture.saved.id);
  release.resolve();
  assert.equal(await running, undefined);
  assert.equal(await fixture.keychain.getCredential(fixture.saved.id), null);
});

test("a company refresh cannot overwrite a login replaced immediately before the atomic file update", async (t) => {
  const fixture = await durableAuthFixture();
  const update = fixture.keychain.updateFiles.bind(fixture.keychain);
  t.mock.method(
    fixture.keychain,
    "updateFiles",
    async (baseline: Parameters<Keychain["updateFiles"]>[0], files: CredentialFile[]) => {
      await fixture.keychain.save({
        ownerId: fixture.saved.ownerId,
        service: fixture.saved.service,
        files: credFiles(authJson("acct", FRESH_EXP, "replacement-refresh")),
      });
      await update(baseline, files);
    },
  );
  const result = await fixture.make(refreshTo("acct").refresh).accessToken();
  assert.equal(result, accessToken("acct", FRESH_EXP));
  const bundle = (await fixture.keychain.materializeOwnFiles(fixture.saved.ownerId))[0]!;
  const auth = JSON.parse(Buffer.from(bundle.files[0]!.contentBase64, "base64").toString("utf8")) as {
    tokens: { refresh_token: string };
  };
  assert.equal(auth.tokens.refresh_token, "replacement-refresh");
});

test("keychain auth logs which auth file is corrupt instead of treating it as absent", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  const state = keychainState(authJson("acct", FRESH_EXP));
  state.files = [
    { path: ".codex/auth.json", contentBase64: Buffer.from("{not json").toString("base64") },
    { path: "other/auth.json", contentBase64: Buffer.from(JSON.stringify({ auth_mode: "apikey" })).toString("base64") },
  ];
  const auth = keychainCompanyChatGPTAuth({
    lock: testAdvisoryLock(),
    keychain: fakeKeychain(state),
    credentialId: "cred-1",
    now: () => NOW,
  });
  assert.equal(await auth.accessToken(), undefined);
  assert.match(logged[0]!, /^\[swallowed\] chatgpt: unusable auth file \.codex\/auth\.json: .*JSON/);
  assert.match(logged[1]!, /^\[swallowed\] chatgpt: unusable auth file other\/auth\.json: not a ChatGPT login/);
});
