# Goodcover v0.1.15 source candidate

This is the record of the 0.1.15 rollout, which production now runs. Some settings
it lists, such as `HARNESS`, no longer exist in the current source. For the current
candidate, see [UPGRADE-0.1.16.md](UPGRADE-0.1.16.md).

The source target is upstream `7417aa2a3f917cf97406914897078ae3b273e173`.
This source sync does not authorize production rollout. Land it with a merge
commit or ancestry-preserving fast-forward; never squash or rebase it.

## Release authorization and QA waiver

On 2026-10-22, Dan explicitly authorized this upgrade's merge and production
release after green static checks, security, authentication and independent
review. Unavailable development-environment and live preproduction QA are
waived, not performed or passed. Remaining UI, Slack and manual acceptance must
be recorded honestly. Production writes require a fresh verified usable database
backup, captured deployed configuration and images, and migration-compatible
recovery. A destructive restore or data reset requires separate authorization.
Private production subscription smoke must avoid customer messages and business
cron execution. Preserve the existing subscription credential and fail closed on
authentication failure; do not add a paid API fallback.

## Qualification and configuration

GC4 uses the existing EKS manifests in the separate ops checkout, rather than a
CLI-generated ECS deployment. There is no `qm.config.jsonc` in this layer. Do not
invent an ECS config to make `qm check`, `doctor`, or `plan` pass. Validate the
actual ops ConfigMaps with this source's configuration loaders, and review the
Kubernetes service environments and image pins separately. No changes to ops or
production are part of this source sync.

Keep the existing Postgres database, organization identifier, connector encryption
key, Google OIDC configuration, and durable Slack installation. Dev QA must use
separate Slack apps and a fresh local database. Keep production credentials out of
dev instances.

Persisted MCP `auth: oauth` records retain their owner-based discovery and explicit
shared/per-user call behavior. They are not silently rewritten to `oauth-user`.
The new `oauth-user` mode always uses the caller's token and rejects credential
hosts that overlap built-in connectors or other registered servers. Existing
conflicting `oauth-user` rows fail closed and require an admin to choose a distinct
credential host. Plain keeps its existing provider, account slots, PKCE, token
rotation, and resource parameter in authorize, exchange, and refresh requests.

Native CLI login files are staged for explicitly selected `execute` credentials,
then saved back and removed when execution finishes. Broad sandbox-wide restoration
is replaced by this upstream flow. Owner execution remains isolated, and current
global skill files use the same session/version paths as scoped skill reads. Room
and personal skill files are excluded from the owner computer.

Review inherited publishing destinations before enabling Actions. Release/image/npm
publishing and the green-main notification are restricted to the upstream repository.
No production publishing or deployment workflow is enabled by this change.

## Pi and existing ChatGPT subscription access

Adopt upstream's Pi runtime while retaining subscription-backed OpenAI usage.
`CODEX_AUTH_CREDENTIAL` continues to identify the existing `qm-default-chatgpt`
file credential. Its service label is not a lookup key: preserve the actual
credential ID and encryption key. Core reads the saved ChatGPT `auth.json`,
refreshes near-expiry tokens under the shared PostgreSQL advisory lock, checks the
account binding, and atomically updates only the auth file in the same keychain
record. Other saved files and operator metadata remain intact. Pi receives only the derived
access token; no refresh token is passed to Pi. A valid, refreshable saved login
needs no re-login solely for this migration. A revoked or unusable login must be
reconnected; do not substitute an API key to hide that failure.

For a separately authorized ops rollout, prepare these settings without applying
them as part of this source sync:

```text
HARNESS=pi
PI_MODEL=codex/gpt-5.6-sol
PI_JUDGE_MODEL=codex/gpt-5.6-sol
CODEX_AUTH_CREDENTIAL=<retain existing credential ID>
MODEL_PROVIDER=openai
```

`CODEX_MODEL` no longer selects the runtime's model; replace it with `PI_MODEL`.
Keep `CLAUDE_AUTH_CREDENTIAL` and the intentional Claude configuration unchanged.
`MODEL_PROVIDER=openai` identifies the logical model family. The `codex/` model
namespace selects Pi's OAuth-only `openai-codex` transport to the ChatGPT backend;
the plain `openai` provider uses the separately metered OpenAI API. No OpenAI API
key is needed for the subscription route. Do not add one as a fallback.

Saved unprefixed OpenAI model IDs from existing chat preferences and crons are
routed to their `codex/` aliases whenever the company subscription is configured.
Missing credentials or models without a supported subscription alias fail closed,
even if an OpenAI API key is also present. Browser inference follows this same
subscription policy independently of the default chat harness or a configured
model gateway. Subscription models bypass gateway mappings, and refusal fallbacks
may only select another subscription model; they cannot silently spend OpenAI or
Anthropic API keys. API-only ultrafast variants and OpenAI
endpoint overrides therefore cannot silently move company work onto metered API
serving under this subscription configuration. Choose a supported subscription
model instead. Other intentionally selected providers retain their own routing.

The existing upstream migration changes saved `codex`/`opencode` harness IDs to
`pi` in scoped base/purpose runtime preferences, approved harness lists, flaggers,
cron overrides, swarm templates, child-session metadata, pending/running requests,
and active runtime handoffs. It preserves model IDs, effort, fast mode, cron
ownership/enabled state, and unrelated Claude settings; archived run history is
left intact. The separate cron ownership migration still needs qualification.
The migration changes harness identifiers, not subscription credentials. Do not
edit its checksum or rewrite all model preferences in the database to do routing.
Explicit personal ChatGPT connections also use Pi's subscription provider, while
scheduled jobs continue to use company model credentials.

## Migration and rollback

Before a separately authorized rollout, qualify the exact candidate against an
isolated copy of the existing database. Retain an independently verified database
recovery point, previous service images, and previous deployment configuration.
Migration-ledger checksum failures must be investigated, never bypassed by changing
or deleting ledger entries.

Stop every old core and worker before migrating. This release drops
`sessions.status`, `tasks`/`task_events`, `session_tape`, and the old transcript
view. It also changes memory storage, cron ownership/history, and ACL file keys.
Old code cannot safely run against the new schema. Rolling back service images
alone is insufficient: restore the compatible database recovery point together
with old code/configuration, accounting for writes made after the recovery point.
New memory facts and cron history are not maintained for older readers.

The tape migration copies metadata to `legacy_tape_steps`, at roughly 30 sessions
per second. GC4's current five-minute startup probe can expire on larger databases.
Plan a separate `node src/migrate-main.ts` run with the candidate's configuration,
after old writers stop and before serving traffic. Verify the isolated migration's
`legacy_tape_skipped` and progress counters, including invalid messages, keyed
blocks, copied steps, and copied turns. Require zero skipped sessions or an explicit
reviewed disposition; process exit success alone is insufficient. Test recovery
from interruption and the old-reader/database-restore rollback path.

Sandbox resources are always enabled. Existing routing and scope/backend mappings
are imported once. Keep all legacy provider credentials/settings until adoption
succeeds, and verify that existing computers and snapshots remain reachable.
`SANDBOX_SECONDARY_BACKEND` and the old sandbox routing/migration controls are
retired; subsequent `SANDBOX_SCOPE_BACKENDS` edits do not move computers.

The source merge does not update deployed service or sandbox images. Build services
from this exact checkout and publish only to Goodcover-owned registries during a
separately approved rollout. Review MicroVM runtime and tool requirements before
changing GC4's sandbox pin; preserve its DNS wrapper and network settings.

GC4's current stock Postgres 17 image does not provide pgvector. Keep optional
memory embedding unconfigured until an extension-capable image and extension
installation are separately planned and validated.
