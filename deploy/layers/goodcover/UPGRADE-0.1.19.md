# Goodcover v0.1.19 source sync

The source target is upstream `v0.1.19`, commit `39954e449381e1f77f9bc8a884c8a8ec525e4245`
(`v0.1.18` is `9c202190be23f8cc042f27ac1e59a5b4feb47d62`), merged with its ancestry onto the
0.1.17 source candidate. It is a source candidate: nothing here has been built, published or
deployed, and no rollout step is approved. Land the sync with a merge commit or an
ancestry-preserving fast-forward, never a squash or rebase.

## Upgrade path

Production runs 0.1.16-gc. The 0.1.17 candidate was never deployed, so GC4 goes from 0.1.16-gc
to this candidate in one step. That step needs everything in [UPGRADE-0.1.17.md](UPGRADE-0.1.17.md)
(single core service and `PUBLIC_PORT`, sign-in settings in core, `PRIVATE_NETWORK_ALLOWED_ORIGINS`
in place of `MCP_PRIVATE_HOSTS`, the one-step 0.1.16 database upgrade) plus the 0.1.18 and 0.1.19
changes below.

## Code and packaging

| Item                                           | 0.1.16-gc               | This candidate                                                  |
| ---------------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| Services and images                            | core, web-ui and portal | core only (from 0.1.17)                                         |
| Node                                           | 24.22.1                 | 24.22.1                                                         |
| Vendored `@earendil-works/pi-ai`               | 0.82.0-qm.3             | 0.82.0-qm.5                                                     |
| Vendored `@earendil-works/pi-coding-agent`     | 0.82.0-security.6       | 0.82.0-security.6                                               |
| `@anthropic-ai/claude-agent-sdk` (Claude Code) | 0.3.308 (2.1.308)       | 0.3.308 (2.1.308)                                               |
| `cc-session-io`                                | 0.4.0                   | 0.4.0                                                           |
| Sandbox Claude Code and Codex                  | 2.1.280 and 0.156.1     | 2.1.280 and 0.156.1                                             |
| GC4 sandbox image                              | version 4.0             | version 4.0; no upstream Dockerfile changed in 0.1.18 or 0.1.19 |

pi-ai qm.5 adds a `fetch` stream option, which core uses to keep custom model providers off
private addresses, and reports the speed an Anthropic call was served at. Neither touches the
company Claude route: custom-provider models never run through Claude Code, and that route
refuses fast mode. The tarball still comes from the `yc-software/qm` GitHub release, so the core
image build needs to reach it, as it did for qm.3.

Build only the core image from this source with `GIT_SHA` set, and publish it only to Goodcover
ECR. The in-build `npm run audit:prod` must pass.

## What changes in 0.1.18 and 0.1.19 for GC4

- **More Claude Code queries per conversation.** Ambient reply detection now runs on the
  conversation's own model (`PI_DETECT_MODEL` is gone). Every new conversation gets a
  descriptive title, no longer behind a flag, written by `claude-sonnet-5-5` unless
  `PI_TITLE_MODEL` names another model. On the
  company Claude subscription, each of these is its own Claude Code query against the
  subscription's limits.
- **App edit chats.** Chats beside a published app use a new org runtime, `app-edit-runtime`,
  which defaults to `gpt-6.1-sol-ultrafast`. The company ChatGPT login serves company OpenAI
  models only through their `codex/` aliases, and that model has none. GC4 configures no metered
  OpenAI key ([AGENTS.md](AGENTS.md)), so the runtime listing does not offer it: app edit chats
  keep the conversation runtime, and core logs `[runtime] app edit runtime unavailable` once. Set
  `app-edit-runtime` to a served model to change that. If a metered OpenAI key is ever added
  beside the company login, the listing offers OpenAI models without a `codex/` alias, this
  default among them, and company turns refuse them.
- **Subagents and swarms.** The `persistent_subagents` and `swarms` flags are removed:
  subagents and swarms are available to every internal person, a swarm starts only on an
  explicit request, and a subagent retires after its final answer unless it was opened
  persistent. `SWARMS_ENABLED` is still the deployment kill switch.
- **New flag, off by default.** `next_prompt_suggestions` predicts a person's next web message
  after each reply on `claude-opus-5-5`: one extra Claude Code query per reply for the people
  it is turned on for.
- **Slack bots.** Turns that other Slack bots start, or that run in a bot's name, can no longer
  use a person's credentials, memory, swarm computers, crons, apps or approvals. QM's own
  Goodcover Slack app is not such a bot.
- **Company ChatGPT login.** v0.1.19 merges concurrent credential file saves per file. When an
  admin replaces the company ChatGPT login while a token refresh is running, the saved login
  wins and the in-flight call reads it again. Before, the call could run on the replaced
  account's refreshed token.
- **Prompt cache.** Upstream now keeps the one-hour cache TTL on system and tools only and
  writes the conversation breakpoint with the five-minute TTL. Claude Code 2.1.308 has one TTL
  for the whole main conversation, so on the company Claude route every breakpoint keeps the
  hour, which is also Claude Code's own default on a subscription. Changing that needs a Claude
  Code release that can split the TTLs.

## Configuration

- **Removed:** `PI_DETECT_MODEL`. Core ignores it; delete it from `qm-core` if set.
- **Widened:** `PRIVATE_NETWORK_ALLOWED_ORIGINS` now also gates custom model provider calls. List
  the origin of any custom model provider that GC4 reaches on a private address.
- **Flags:** `persistent_subagents`, `swarms` and `descriptive_session_titles` are removed;
  `next_prompt_suggestions` is added, off.
- **New org setting:** `app-edit-runtime` (admin resource), unset by default.
- No new environment variables. No schema change from the fork itself.

## Database

Upstream 0.1.18 and 0.1.19 add migrations on top of 0.1.17's: they drop `session_leases`,
`items.target_seq` and the participant window columns, clean up after a failed 0.1.16 upgrade
(`0000-tenancy/retire-0116-hosts`), and replace the boot and serving tenant functions
under new ids so managed Postgres owners can run them. Run migrations with the schema owner or
a role that owns `qm_schema_migrations` and has `CREATE` on the schema. As for 0.1.17, run this
candidate's `node src/migrate-main.ts` once as a one-off job with traffic, Slack and background
work stopped, after a verified backup. Old images cannot run on the migrated schema, so
recovery means restoring that backup with the previous images and configuration.

Rehearsed on isolated Postgres 16 with pgvector, each time with a synthetic row seeded into
every table the generic seeder can fill and a second run that changed nothing:

| From                                         | Tables seeded | Ledger ids  |
| -------------------------------------------- | ------------- | ----------- |
| 0.1.16-gc (`b471e1050`)                      | 142 of 161    | 585 → 1857  |
| 0.1.17 candidate (`17a3abdcc`)               | 148 of 172    | 1344 → 1496 |
| `v0.1.18`, migrated by a non-owner app login | 150 of 174    | 1494 → 1496 |

On 0.1.17 and later schemas the seeder fills tenant-scoped tables only when its session binds
the tenant (`qm.tenant_id`). Neither rehearsal qualifies production data; repeat it on a
restored copy of production.

## Canary after the image that brings this in

Reuse the 0.1.17 canary list, and also check:

- a new Slack conversation gets a descriptive title, and each `[claude-code] query started …`
  line for it shows `apiKeySource=none`;
- an ambient channel message is judged without a `managed_settings` or billing refusal;
- an app edit chat starts on the conversation runtime;
- `[claude-code] subscription limit …` stays `"isUsingOverage":false` under the extra title and
  detection queries.

Roll back on the same conditions as 0.1.17.
