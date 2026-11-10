# Goodcover v0.1.17 source sync

The source target is upstream `v0.1.17`, commit `0ceacbc4765b2c9b238b73832d78643417ba2f93`,
merged into this fork with its ancestry. It is a source candidate: nothing here has been built,
published or deployed, and no rollout step is approved. Land the sync with a merge commit or an
ancestry-preserving fast-forward, never a squash or rebase.

## What changes for GC4

- **One service.** Core now serves the web UI, the sign-in portal and the sign-in broker on a
  public front door. The `web-ui` and `portal` images and their Kubernetes deployments are no
  longer used. Core refuses to start in production without `PUBLIC_PORT`, which must differ from
  `PORT` (8080). Point the ingress at core's public port; the API port stays in-cluster.
- **Sign-in settings move into core.** The portal's Google Workspace OIDC settings (`OIDC_*`) and
  its `PORTAL_*` secrets move from `qm-portal` to `qm-core`, and `PUBLIC_WEB_URL` is the one
  public URL. Upstream's Helm notes, under "Upgrading from chart 0.3", list the same moves and
  say the switch signs every user out once.
- **Web UI releases.** At boot core publishes the web UI bundled in its image as a release: to
  the S3 snapshot bucket when `SNAPSHOT_STORE=s3`, otherwise under `DATA_DIR/web-ui`.
- **Private network origins.** Upstream's `PRIVATE_NETWORK_ALLOWED_ORIGINS` replaces
  Goodcover's `MCP_PRIVATE_HOSTS`, which core no longer reads. It lists exact origins
  (`scheme://host:port`) that core may call on a private address, for MCP, OAuth discovery and
  memory providers. Loopback, link-local and cloud metadata addresses stay refused. In `qm-core`,
  replace `MCP_PRIVATE_HOSTS: signoz-mcp.signoz.svc.cluster.local` with the SigNoz MCP record's
  origin, such as `http://signoz-mcp.signoz.svc.cluster.local:<port>`. Without it, SigNoz MCP
  calls fail with an error naming `PRIVATE_NETWORK_ALLOWED_ORIGINS`.
- **Model routes.** Upstream moved route resolution into `createModelRoutes`, and the browser
  tool now runs on the session's route. Goodcover's rules moved with it, unchanged:
  - company Claude routes on a subscription token run through Claude Code, and fast mode is
    refused;
  - a company OpenAI model always routes to its `codex/` alias and fails closed without one;
  - a subscription-served turn or summary falls back only to another subscription
    (`[pi] fallback … skipped`);
  - company Claude browser requests are refused; company ChatGPT browser requests stay on the
    subscription and off the gateway.
- **Slack turns delegate.** Slack turns by internal people now run as coordinators that hand
  command work to subagents and have no `execute` tool. On the company Claude route each
  subagent turn is another Claude Code query, so one request can use several queries of the
  subscription's limits.
- **Claude Fable 5.2** is selectable. On the company Claude subscription it runs through Claude
  Code like the other Claude models, and its fast mode is refused.
- **MCP admin.** A new server saved without `auth` probes its URL and registers as `oauth-user`
  when it offers OAuth, with dynamic client registration when available. An omitted `readOnly`
  keeps the stored value, or `false` for a new server. Plain's legacy `oauth` mode and the
  128-tool cap are unchanged.

## Database

0.1.17 upgrades a single-tenant 0.1.16 database in one step: `0000-tenancy/base/retire-0116-keys`
puts tenant-first keys back on plain keys and drops 0.1.16 tenancy leftovers. It refuses a
database holding more than one tenant. Run this candidate's `node src/migrate-main.ts` as a
one-off job with traffic, Slack and background work stopped, after a verified backup. Old
images cannot run on the migrated schema, so recovery means restoring that backup with the
previous images and configuration.

Rehearsed on an isolated local Postgres 16 with pgvector: the pre-merge fork (`b471e1050`)
migrated a fresh database, a generic seeder wrote a synthetic row to 142 of its 161 tables, this
candidate migrated it (585 to 1707 ledger ids) and a second run changed nothing. Upstream's
`test/upgrade-from-0116.test.ts` upgrades a seeded 0.1.16 fixture. Neither qualifies production
data; repeat the rehearsal on a restored copy of production.

## Canary after the image that brings this in

Reuse the 0.1.16 canary and watch for:

- `[claude-code] query started … apiKeySource=none`, and `[claude-code] subscription limit …`
  with `"isUsingOverage":false`, on each company Claude query;
- no `managed_settings` refusal, and a follow-up turn that reads the prompt cache;
- one ChatGPT-subscription turn, one SigNoz MCP call and one Plain MCP call completing;
- Google Workspace sign-in through core's front door, and `/settings` loading.

Roll back to the previous images and the pre-migration backup if a Claude turn fails with
`managed_settings` or a billing refusal, a Codex turn fails, or core restarts or is `OOMKilled`.
