# Goodcover v0.1.16 source candidate

The source target is upstream `v0.1.16`, commit
`16ae628535be19486ce2ed95d65c998c2a85a1f0`. The candidate is not deployed, and this
source sync does not authorize a rollout. Each rollout step below needs its own
approval. Land the sync with a merge commit or an ancestry-preserving fast-forward.
Never squash or rebase it.

Production stays on `0.1.15-gc.1`, which is source `f43507f4` and MicroVM 4.0. The
authoritative pins live in ops `gc4/packages/qm/images.json`. This change does not
touch them. Delete this guide once production runs 0.1.16 and its pre-hop-1 backup
is no longer needed for recovery.

## What changes for GC4

- **One agent.** Pi is now the only agent. Upstream removed the Claude Code harness,
  the `HARNESS` and `CLAUDE_MODEL` settings, and the approved-harnesses setting and
  table. Core ignores those variables instead of rejecting them.
- **Claude through Claude Code.** `CLAUDE_AUTH_CREDENTIAL` is the company Anthropic
  credential. Upstream sends it from Pi straight to the Messages API, which Anthropic
  bills as a third-party app and refuses while Extra Usage is off. Goodcover serves
  every company Claude route through the Claude Code binary bundled with
  `@anthropic-ai/claude-agent-sdk` instead, as 0.1.15's harness did. Pi still runs the
  turn and QM's tools. The existing setup token has no refresh, so replace it when it
  expires. Personal Claude accounts and metered keys keep Pi's direct path.
- **Admin UI.** The admin dashboard is folded into web-ui at `/settings`, and the
  separate admin plugin is gone.
- **Credentials in shared conversations.** Upstream removed the owner credential
  computer. A command in a shared conversation that names a private credential now
  runs on the turn's scratch computer. Goodcover lays the current organization skills
  that ship files onto that scratch computer, at the same paths the skill tool
  reports. Room and personal skills are not copied there. A skill that fails to copy
  is recorded as `tree_materialize_failed`, and the computer stays usable. Background
  job computers do not get these skills.
- **Multitenancy.** Upstream adds `tenant_id`, row-level security and tenant-first
  keys to every table. A single tenant on the table-owner login keeps working with
  no new settings.
- **Scheduled work in the prompt.** Production limits the "Scheduled here" block to
  10 each of scheduled tasks, webhooks and job watches. This candidate drops that
  limit, as upstream did, and upstream now renders the block in the cached system
  prompt. A scope with more scheduled work lists all of it.

## Goodcover routing and spend policy

These Goodcover rules sit on top of upstream:

- **ChatGPT subscription.** A company OpenAI model ID always routes to its `codex/`
  subscription alias. A missing login, or a model with no subscription alias such as
  an ultrafast variant, fails closed even when an OpenAI key exists.
- **Rotated logins are saved.** Upstream now saves refreshed keychain files only when
  the caller opts in. Goodcover's company ChatGPT refresh opts in, so each rotation
  is persisted and the next refresh does not reuse a spent token. The person who owns
  the company ChatGPT credential can still save it from their own commands, outside
  that lock. Keep it owned by an account that never runs commands with it.
- **Claude subscription.** When `CLAUDE_AUTH_CREDENTIAL` is configured, company Claude
  traffic uses only that credential, and the company subscription is reported as
  Anthropic. A saved or environment Anthropic API key cannot take it over. If the
  subscription yields no token, company Claude requests fail closed. This includes
  an `ANTHROPIC_API_KEY` set in per-tenant settings.
- **Fallbacks.** A company turn or summary served by a subscription may fall back
  only to another subscription route, never to a metered key. Routes record this as
  `org_subscription` billing, and fallback notes say "billed to the organization's
  subscription". Upstream now also falls back on `auth` and `model_budget` failures.
  ChatGPT HTTP failures are classified `unknown` and do not fall back at all. A
  person's own accounts keep upstream's fallback.
- **Browser inference.** Upstream now reports the company subscription provider as
  `anthropic` whenever a Claude credential is configured. Goodcover keeps company
  OpenAI browser models on the ChatGPT subscription and off the gateway.
- **Gateway.** Subscription (`openai-codex-responses`) models bypass gateway
  mappings.

Do not add an OpenAI or Anthropic API key to make a warning or onboarding prompt go
away.

## Connectors

- **Plain over MCP.** Persisted MCP `auth: "oauth"` records keep their owner-token
  discovery and their shared or per-user calls, and an admin can re-save them. New
  servers can no longer choose `oauth`; they must use `oauth-user`. Per-user and
  `oauth` servers now require HTTPS, with no loopback exception.
- **Retiring `oauth` (Dan to decide).** Plain is registered as a confidential
  `client_secret_post` client, and upstream's `oauth-user` supports only public PKCE
  clients. Retiring `oauth` therefore needs a public Plain client and a one-time
  reconnect by every user. After that, the Plain record moves to `oauth-user`, and
  `oauth`, `oauthPrincipalId` and the built-in `plain` provider can be deleted.
- **OAuth host conflicts.** `oauth-user` hosts that overlap a built-in connector or
  another server still fail closed. Matching ignores case, a trailing dot and
  subdomains.
- **Tool cap.** The MCP tool cap moved into the client. Goodcover keeps 128 tools per
  server, upstream 64, because Plain lists 77. A server that lists more is now
  logged: `[mcp] <host> lists more than 128 tools`. Upstream's alternative is
  `catalog: true` on the Plain record, which serves Plain through one search,
  describe and invoke tool and would let this divergence go. That changes how the
  agent reaches Plain, so it is Dan's decision.
- **Approval default.** The new default approval policy, `annotations`, makes tools
  annotated as destructive wait for a person. Unattended crons that call such tools
  will pause. Choose the approval policy for the Plain server before rollout.
- **Network.** MCP and OAuth endpoints now refuse private addresses and ignore
  `HTTP(S)_PROXY`. Core must reach `mcp.plain.com` and `signin.auth.plain.com` over
  public DNS. The in-cluster SigNoz MCP server keeps working only through
  `MCP_PRIVATE_HOSTS`; see the layer README's
  [Divergences from upstream](README.md#divergences-from-upstream).

## Configuration to prepare, not apply

After hop 3, remove these keys, which the candidate ignores, from the ops ConfigMaps:

- `qm-core`: `HARNESS`, `CLAUDE_MODEL`, `SESSION_STORE`, `RUN_STORE` and
  `FILES_DIRECT_UPLOADS_ENABLED`.
- `qm-web-ui`: `ADMIN_BASE_PATH` and `ADMIN_ENABLED`.
- `qm-portal`: `ADMIN_UPSTREAM`.

Add `MCP_PRIVATE_HOSTS: signoz-mcp.signoz.svc.cluster.local` to `qm-core` before the
candidate starts.

Keep `SESSION_STORE=postgres` and `RUN_STORE=postgres` for the B1 and B2 jobs, which
still read them. Keep `CONNECTOR_SECRET_KEY` and `ORG_ID` identical across every hop.

Keep `CODEX_AUTH_CREDENTIAL`, `CLAUDE_AUTH_CREDENTIAL`, `PI_MODEL`, `PI_JUDGE_MODEL`
and `MODEL_PROVIDER=openai` unchanged. The real `qm-core` ConfigMap, with synthetic
secrets, loads under this candidate's config loader. The required core secret set is
unchanged from 0.1.15.

For the Kubernetes rollout:

- Build images with `GIT_SHA`. Background work and Socket Mode start only after
  older builds stand down, so expect a short Slack gap.
- Set core `terminationGracePeriodSeconds` to at least 60.
- Check Postgres `max_connections` for the new pools: 20 shared plus 64 direct per
  process.
- Upgrade core before web-ui and portal. Both resolve the tenant from core on every
  request.
- Leave the sandbox image alone. The MicroVM agent source moved to
  `cli/templates/aws/microvm-agent`. Its `agent.mjs` and `Dockerfile` are
  byte-identical to `f43507f4`'s, and the Goodcover wrapper is unchanged, so the
  source-built archive inputs are unchanged and deployed MicroVM 4.0 stays.
- Expect `memory vector index` errors every 30 seconds. Upstream now tries
  `CREATE EXTENSION vector` even without an embedding model, and GC4's stock
  Postgres 17 has no pgvector. The errors do not block boot.

## Database upgrade: three migration hops

**v0.1.16 cannot start on the production database directly.** It squashed the
session, run and directory migrations into base schemas, and it retired a boot-time
origin rewrite. Guards refuse a database that skipped the intermediate migrations,
and v0.1.15 never applied them:

| v0.1.16 guard                        | Needs in `qm_schema_migrations`               | First applied by                         |
| ------------------------------------ | --------------------------------------------- | ---------------------------------------- |
| `sessions/store/0047-base-schema`    | `sessions/store/0046-spend-days-cron-rebuild` | upstream `d95d5237f` (B1)                |
| `runs/store/0011-base-schema`        | `runs/store/0010-drop-turn-metrics`           | upstream `d95d5237f` (B1)                |
| `surfaces/0005-retired-origin-sweep` | `surfaces/0004-settled-runs-rewrite`          | a full boot of upstream `f17b8d80f` (B2) |

No single commit satisfies all three guards, so the database must pass through two
untagged upstream commits in order: v0.1.15 → B1 → B2 → this candidate. Neither
bridge contains Goodcover's changes. Run them only as maintenance jobs with traffic,
Slack and background work stopped.

Run each hop as a one-off job with no startup probe, using the candidate's
configuration and the table-owner `DATABASE_URL`:

1. **Hop 1.** Run B1's `node src/migrate-main.ts`. Then confirm the ledger contains
   `sessions/store/0046-spend-days-cron-rebuild` and
   `runs/store/0010-drop-turn-metrics`, and that `session_entries` is gone.
2. **Hop 2.** Run B2's `node src/migrate-main.ts`. Confirm no runs are pending or
   running, because the B2 worker starts draining them right after the rewrite.
   Then run B2's `node src/runs/worker-main.ts` with `BACKGROUND_DEPLOYMENT_ID`
   unset and `BACKGROUND_WORK_ENABLED=false`. Stop it once it logs `draining runs`
   and `surfaces/0004-settled-runs-rewrite` is in the ledger. Without
   `BACKGROUND_WORK_ENABLED=false`, B2 would start crons, wakes and deliveries on
   upstream code, which has none of Goodcover's protections.
3. **Hop 3.** Run this candidate's `node src/migrate-main.ts`, then start the
   candidate privately.

Before hop 3, run the row checks of `surfaces/0005-retired-origin-sweep` read-only.
Run it from a machine with `node`, `psql` and a checkout of this candidate, pointed
at the same `DATABASE_URL` as the hop jobs; the core image may not ship `psql`. Print
the migration's check block and run it inside a read-only transaction:

```sh
{ echo 'BEGIN TRANSACTION READ ONLY;'
  node --input-type=module -e 'const { RETIRED_ORIGIN_SWEEP_MIGRATION: m } = await import("./src/surfaces/origin-migration.ts"); console.log(`${m.statements[0]};`)'
  echo 'ROLLBACK;'
} | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q
```

Continue only when it exits 0 with no output. An error names the table holding rows
in the old shape; repeat hop 2's worker step, then check again. Do not rely on hop 3
to catch them: migrations run in id order, and most of hop 3 commits before
`surfaces/0005`.
If hop 3 fails there anyway, restore the backup. On first start, the candidate also
delivers outbox rows left at cutover if they are less than six hours old.

**Synthetic rehearsal.** All three hops were run on an isolated local Postgres
holding synthetic Goodcover-shaped rows, starting from `f43507f4`'s own migrations
and ending with this candidate's code:

- **Hop 1** added 46 ledger ids. It copied the expected transcript entries into
  `items`, dropped the legacy tables, and stripped harness IDs. Model, effort, fast
  mode and `enabled: false` were kept.
- **Hop 2** added 16 ids. Its worker recorded `surfaces/0004` about three seconds
  after start, with no Slack or model credentials. It started no run, delivery or
  cron.
- **The `surfaces/0005` pre-check** above refused before the worker step, exited 0
  after it, and named `deliveries` when an old-shape row was inserted in a
  rolled-back transaction.
- **Hop 3** added 377 ids, then the candidate served `/healthz` and `/readyz`. The
  `plain` MCP record kept `auth: "oauth"` and `oauthPrincipalId`, the paused cron
  stayed paused, and keychain secrets still decrypted.
- **Timing at scale:** with 605 sessions, 114k transcript entries and 6k runs (107 MB),
  hop 1 took 22 seconds, and hops 2 and 3 about 4 seconds each.
- **Direct boot:** booting v0.1.16 directly on the 0.1.15-shaped database failed at
  `admin/audit-log/0003-tenants`, after committing 12 tenancy ledger ids.

The rehearsal is evidence that the procedure works, not qualification of production
data. Repeat it on a restored copy of production.

What the hops change:

- **Hop 1 (B1).**
  - **Transcripts.** It copies every `session_entries` row into `items` in one
    transaction, then drops the legacy history tables. Allow two to three times the
    transcript storage in free disk.
  - **Other drops.** It drops `turn_metrics`, `approved_harness_configs`,
    `connector_status`, `pinned_skills` and `internal_member_overrides`, plus the
    `session_llm_requests.request` column.
  - **Harness IDs.** It strips every saved harness ID. Model IDs, effort, fast mode,
    cron ownership, enabled state and schedules are kept.
  - **Recipient consent.** It strips `recipientConsent` from crons, webhooks and
    loops, so teammate messages that were pending or declined start delivering.
- **Hop 2 (B2).**
  - It drops `rate_limit_windows`, `tool_calls` and the `items_search` index.
  - It backfills session facts, and rewrites stored Slack origins and destinations.
  - It records `surfaces/0004`, but only during a worker or server boot.
    `migrate-main` does not record it.
- **Hop 3 (candidate).**
  - **Multitenancy.** It adds the tenant column, row-level security and rebuilt
    primary keys to every table.
  - **Participants.** It deletes participant rows for people who left a
    conversation.
  - **Retired tables.** It drops 13 retired key-value tables.
  - **Deployment names.** It fails if two deployments share a name.
  - **Cron history.** It strips any `fireLog` left in cron records. B2's boot has
    already imported it.

**No rollback after hop 1 can be image-only.** Old code cannot run on the migrated
schema. Recovery means restoring the database to its pre-hop-1 backup, together with
`f43507f4` images and configuration. Posts made after that backup must also be
accounted for.

## Pre-flight on an isolated copy of production

Do this on a restored copy with no production encryption key and no running
application:

1. **Ledger.** `qm_schema_migrations` must contain `sessions/store/0033-client-tools`,
   `runtime/0001-legacy-harnesses-to-pi` and `directory/store/0005`. It must contain
   neither `sessions/store/0046-spend-days-cron-rebuild` nor
   `runs/store/0010-drop-turn-metrics`.
2. **Sizes.** Record sizes and row counts for `session_entries`, `sessions`, `runs`,
   `session_llm_requests`, `memory_facts`, `channel_messages`, `participants` and
   `approvals`. Confirm free disk.
3. **Timeouts.** As the migration (table-owner) role, `statement_timeout` and
   `lock_timeout` must be 0, or set per job.
4. **Duplicate deployment names.** This query must return no rows:
   `SELECT json->>'name', count(*) FROM deployments GROUP BY 1 HAVING count(*) > 1`.
5. **Recipient consent.** Find crons, webhooks and loops whose
   `json->'recipientConsent'->>'status'` is `pending` or `declined`, and decide how to
   handle each. Confirm the three security-paused crons from the 0.1.15 rollout are
   still `enabled = false`: `9dc8b56ff4cc8cf9`, `b80de1169500d080` and
   `daa5aaa9a77e1436`.
6. **Member overrides.** Export `internal_member_overrides`, and record what happens
   to each entry.
7. **MCP servers.** Check `mcp_servers` for private or in-cluster URLs. Choose the
   Plain approval policy.
8. **Plain tokens.** Confirm stored Plain connector tokens have host `mcp.plain.com`.
9. **Rehearse.** Run all three hops on the copy, on stock Postgres 17 without
   pgvector, as in production. Time each one against the job
   timeout. Record the per-hop ledger additions. Hop 2 must record `surfaces/0004`,
   and hop 3 must finish. Afterwards, confirm credential and grant counts are
   unchanged, the three paused crons are still paused, and the `plain` MCP record
   still has `auth: "oauth"`.

## Rollout checklist (requires separate approval)

1. **Prove credentials before touching production.** A credential problem found
   only at step 6 comes after an irreversible migration, so first boot this candidate
   as a web-only dev instance (`/dev-instance`) on a fresh database. Use only
   developer-owned accounts, never production ones:
   - **ChatGPT.** Save a developer ChatGPT account's `.codex/auth.json` (from
     `codex login`) as a file credential in the dev admin's Keychain, and set
     `CODEX_AUTH_CREDENTIAL` to that entry's ID.
   - **Claude.** Save a developer Claude subscription setup token (from
     `claude setup-token`) as an environment credential named
     `CLAUDE_CODE_OAUTH_TOKEN`, and set `CLAUDE_AUTH_CREDENTIAL` to its ID.
   - **Plain.** Register a developer Plain client with `client_secret_post` and the
     dev instance's callback, `<dev origin>/v1/connectors/oauth/plain/callback`. Set
     `PLAIN_OAUTH_CLIENT_ID` and `PLAIN_OAUTH_CLIENT_SECRET`, and connect a developer
     Plain workspace in Keychain. The admin API no longer creates `auth: "oauth"`
     servers, so stop the dev instance and seed the legacy record through the store
     from the checkout. Run it with the dev instance's environment, including its
     table-owner `DATABASE_URL`, `ORG_ID` and `CONNECTOR_SECRET_KEY`, and with
     `PLAIN_OWNER` set to the principal that connected Plain. Then start the instance
     again:

     ```sh
     node --input-type=module -e '
     const { loadConfig } = await import("./src/config.ts");
     const config = loadConfig();
     const owner = process.env.PLAIN_OWNER;
     if (config.production) throw new Error("refusing: NODE_ENV is production");
     if (!owner) throw new Error("set PLAIN_OWNER");
     const { default: pg } = await import("pg");
     const db = new pg.Client({ connectionString: config.databaseUrl });
     await db.connect();
     const booted = await db.query("SELECT 1 FROM qm_schema_migrations WHERE id = $1", ["surfaces/0005-retired-origin-sweep"]).catch(() => ({ rowCount: 0 }));
     const seeded = await db.query("SELECT 1 FROM mcp_servers WHERE id = $1", ["plain"]).catch((e) => { if (e.code === "42P01") return { rowCount: 0 }; throw e; });
     await db.end();
     if (!booted.rowCount) throw new Error("refusing: this database has not run 0.1.16");
     if (seeded.rowCount) throw new Error("refusing: a plain MCP record already exists");
     const { buildApp } = await import("./src/wiring.ts");
     const built = buildApp(loadConfig());
     await built.mcpServers.put({
       id: "plain", name: "Plain", url: "https://mcp.plain.com/mcp", auth: "oauth",
       credentialScope: "per-user", credentialHost: "mcp.plain.com", oauthPrincipalId: owner,
       readOnly: true, enabled: true, updatedAt: Date.now(), updatedBy: owner,
     });
     process.exit(0);'
     ```

     The guard refuses production config, a database that has not run 0.1.16 (such
     as live 0.1.15 production, where the store would otherwise apply hop 3
     migrations out of order), and any database that already has a `plain` record.
     Before running it, set `credentialScope` and `readOnly` to match production's
     Plain record, as shown in `/settings`, and add its `approval` and `catalog`
     values if it has them.

   Run the step 6 checks there. For the rotation check, a second process must read
   back the rotated login. Then break each subscription credential in turn, with an
   API key and a fallback runtime configured, and confirm the turn fails without any
   request to `api.openai.com` or to a metered Anthropic key. The broken Claude
   subscription also logs `[pi] fallback … skipped`; a broken ChatGPT login fails
   without attempting a fallback. Slack is covered only if a dev Slack app is
   provided; otherwise it is first exercised at step 7.

2. **Build.** Build core, web-ui and portal from this exact merged source with
   `GIT_SHA`. Publish only to Goodcover ECR. Keep the `0.1.15-gc.1` digests.
3. **Back up.** Take a fresh backup, then decode it, verify its checksum, restore it
   into an isolated database and retain it. Capture the deployed ConfigMaps and
   image pins.
4. **Stop old writers.** Stop every v0.1.15 core, worker and background process,
   including Slack. Drain or cancel pending runs, so the bridge workers cannot
   execute them with upstream code.
5. **Run the hops.** Run hops 1 to 3 as separate jobs with no startup probe, as
   rehearsed. Check the ledger after each hop. Never edit or delete ledger entries.
6. **Start privately.** Start the candidate privately with background work
   disabled. Verify health and the migration logs. Then verify:
   - one private ChatGPT-subscription turn;
   - one private Claude-subscription turn;
   - one read-only Plain MCP call from each of those turns;
   - a forced ChatGPT refresh that persists a rotated token;
   - the `/settings` admin pages;
   - no OpenAI or Anthropic API key in use: request captures label every route
     "billed to the organization's subscription", and provider-console usage for
     any API key stays flat.

   Watch for these log lines:
   - `[model] company ChatGPT auth … yielded no token`
   - `[model] company Claude subscription credential … yielded no token`
   - `[claude-code] query started … apiKeySource=none` on each company Claude query, and
     `[claude-code] subscription limit …` with `"isUsingOverage":false`
   - `[pi] fallback … skipped`
   - `[swallowed] chatgpt: company oauth refresh`
   - `[mcp] … lists more than 128 tools`

   If a rotation is dropped, or the provider reports `refresh_token_reused`, the
   shared ChatGPT login must be reconnected; core will not fall back to a metered
   key.

7. **Resume.** Resume background work deliberately and watch Slack reconnect. Keep
   the three paused crons paused unless their permissions are reviewed. Send one
   Slack DM after the background handoff and confirm the reply arrives.
8. **Update ops last.** Update the image pins and ConfigMaps in ops in a separate
   reviewed PR.

## Recovery

Roll back by restoring the verified pre-hop-1 backup, together with the `0.1.15-gc.1`
images and the captured ConfigMaps. That restore is a destructive data operation and
needs explicit authorization, plus a plan for writes made after the backup.

If v0.1.16 is booted directly by mistake, compare the ledger with the v0.1.15 id
set. If anything beyond `0000-tenancy/*`, `0001-tenancy/*` and
`acl/grants/0004-grantee-index` was applied, restore the backup.

If a concurrent index build or lock timeout interrupts a hop, find the blocker in
`pg_stat_activity` and rerun the hop. The runner drops invalid indexes and rebuilds
them.

## Goodcover divergences carried forward

The deployed-app origin and the missing credential sweep carry forward unchanged.
The layer README records both under
[Divergences from upstream](README.md#divergences-from-upstream).
