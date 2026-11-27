# Goodcover QM

QM source and customizations live in this private repository. The working checkout
is `~/projects/qm`. Production is <https://qm.gc4.infra.goodcover.com>.

## Repository responsibilities

| Location                   | Owns                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| This source tree           | QM application changes and source builds                                                            |
| `deploy/layers/goodcover/` | Goodcover sandbox customization and operator entry points                                           |
| `../ops/gc4/packages/qm/`  | Live Kubernetes manifests, image pins, encrypted secrets, gateway operations and deployment history |
| `../ops/gc4/env/qm*.tf`    | AWS resources, managed with GC4's Terraform 1.5.7 environment                                       |

The ops checkout is required for production operations. Set `--ops-root` on the
operator command when it is not a sibling of this checkout. Secrets stay in ops;
this repository has no git-crypt configuration.

The existing EKS deployment predates this source fork. It does not use the
upstream CLI's AWS/ECS provisioning path. Do not run `qm up --target aws` to update
GC4. No ECS infrastructure or new resources are needed for this repository setup.

## Work locally

```sh
cd ~/projects/qm
npm ci --ignore-scripts --no-audit --no-fund
git switch -c goodcover/my-change
npm run typecheck
npm run lint
```

Run the tests affected by a change. Install plugin dependencies in the relevant
plugin directory when working on a surface. Follow the root AGENTS.md review
requirements before merging. Keep org configuration, skills, and sandbox changes
under this layer; edit application source where the behavior belongs.

## Operate the current deployment

```sh
python3 deploy/layers/goodcover/ops.py status
python3 deploy/layers/goodcover/ops.py images
```

The following explicitly reapplies the existing ops manifests and restarts the
three app services. It requires an authorized, decrypted ops checkout:

```sh
python3 deploy/layers/goodcover/ops.py deploy
```

`ops.py network-test` tests an already-created isolated canary. It does not create
one or select a user's computer. Canary creation and retirement are documented
in `../ops/gc4/packages/qm/network/README.md`.

## Sandbox source builds

`sandbox/microvm-runtime.mjs` carries the deployed DNS behavior: AWS run and resume
hooks bind a guest-local resolver file over `/etc/resolv.conf`, directing DNS to
the dedicated gateway at `172.16.31.250`. The image requires `ALL` additional guest
OS capabilities. Gateway infrastructure and enrollment credentials stay in ops.

Build an archive locally, using **this checkout's** `cli/templates/aws/microvm-agent/Dockerfile`
and `agent.mjs`, plus the Goodcover wrapper:

```sh
python3 deploy/layers/goodcover/build-image.py
```

This prints its SHA-256 and saves `.local/gateway-image.zip`. It makes no AWS
calls. After authorizing an image update, `--publish` uploads the archive to the
existing bucket and creates a new version of the existing MicroVM image. It
preserves the explicit CPU, memory, logging, capability, and lifecycle settings.
It does not switch active computers or change production version pins. Wait for
the image to become ACTIVE, test an isolated canary, then review the ops pin
change and migration separately. Follow the snapshot and rollback procedure in
the ops network runbook.

The copied wrapper has formatting changes, so this source archive is not a
byte-for-byte reproduction of deployed version 4.0. The original npm-pinned
builder in ops remains the record of that release. New sandbox work belongs here.

## Application builds and production versions

`app-origin/`, `plain-oauth/` and `plain-tool-catalog/` record how the 0.1.11-era
images were derived from older pins. Their behavior now lives in this source tree,
and current releases build every service from source, so their patches and
Dockerfiles are no longer a build path.

`deployed-baseline.json` records the production pins at fork setup, including
QM package 0.1.11, its source commit, and MicroVM version 4.0. It is historical;
`ops.py images` reads the authoritative current pins from ops.

The source checkout was seeded from upstream main. It is newer than the deployed
release. Importing this source does not upgrade production. Application source
changes require building the affected service Dockerfiles under `deploy/`,
publishing to a Goodcover-owned registry, and updating the immutable image
references in ops after validation. No automatic deployment or image publishing
pipeline is enabled by this setup.

The Goodcover Slack bot is configured through QM's admin settings. Its encrypted
installation lives in Postgres and core starts the Socket Mode connection. Keep
the existing database, `ORG_ID`, and `CONNECTOR_SECRET_KEY` during upgrades; do not
create a second connection with production bot credentials for local QA. The
0.1.12 source update accepts the existing 0.1.11 installation without migration
or token re-entry. Ops owns the release's immutable image pins and rollout record.

## Divergences from upstream

- **Deployed apps on the QM origin.** Dan authorized removing the deployed-app
  browser sandbox on 2026-09-17; see `app-origin/README.md`. Apps proxied through
  `/d/`, the admin deployment proxy and `/deployments/` run on the QM origin without
  a sandbox CSP, and can make authenticated same-origin requests as the viewer.
  Upstream's documentation of sandboxed proxied HTML, including `docs/porter.md`,
  does not apply to this fork.
- **Antigravity model login.** One opt-in Google login served through the Antigravity CLI
  inside bubblewrap gives company-model users Gemini 4 Neon; see
  [`docs/antigravity.md`](../../../docs/antigravity.md). It is off unless
  `ANTIGRAVITY_PROFILE` is set.
- **No age-based credential sweep.** Upstream deletes command credential directories
  in `/tmp` after two hours. Goodcover removed that sweep because it could delete the
  credentials of a command still running. A directory left behind by a crash remains
  until that computer is replaced.

## Historical deployed baseline: Claude Code alongside Codex

The instructions in this section describe the pre-0.1.15 deployed baseline.
They are not configuration instructions for the current source. Production now
runs 0.1.15-gc.1 on Pi; see [UPGRADE-0.1.15.md](UPGRADE-0.1.15.md). The 0.1.16
source removes the Claude Code harness and the harness picker entirely; see
[UPGRADE-0.1.16.md](UPGRADE-0.1.16.md).

The deployed core already includes the Claude Code harness. Adding a token to
Keychain does not automatically approve the harness or connect the credential
to core. These are separate settings:

| Setting                                       | Value                                    |
| --------------------------------------------- | ---------------------------------------- |
| Keychain credential environment-variable name | `CLAUDE_CODE_OAUTH_TOKEN`                |
| Core `CLAUDE_AUTH_CREDENTIAL`                 | The keychain entry's ID, never its token |
| Organization `approved-harnesses`             | `codex` and `claude`                     |
| Core `HARNESS`                                | `codex`, preserving the existing default |

`CLAUDE_MODEL=claude-sonnet-5` sets Claude's fallback model. Core reads these
configuration references at startup. Apply the ops ConfigMap and restart only
core after active jobs finish. Set the organization approval through QM's admin
API at `PUT /v1/admin/scopes/org%3Agoodcover/approved-harnesses` with
`{"ids":["codex","claude"]}`, preserving any other intentionally approved IDs.

After enabling, refresh QM, open the **Codex** harness picker beside the model
picker in the chat composer, and select **Claude Code**, then a Claude model.
In the compact/mobile layout, open **Session settings** to find **Harness**.
This chooses the harness for the conversation; **Make default** changes the
scope's default. Leave that action unused to retain the existing Codex default.

Validate with an isolated Claude reply, QM title presence, and persisted turns;
archive the verification conversation afterward. Keep token values in QM's
encrypted keychain. The setup-token credential has no refresh token, so replace
it when expired or revoked. The entry's ID is safe to keep in ops configuration.

## Upstream updates and CI

Production runs 0.1.16-gc ([UPGRADE-0.1.16.md](UPGRADE-0.1.16.md)); ops holds the exact
pins. The 0.1.19 source candidate is not deployed, and neither was 0.1.17. Moving production
to 0.1.19 needs both [UPGRADE-0.1.17.md](UPGRADE-0.1.17.md) (single-service layout, configuration
changes, the 0.1.16 database step) and [UPGRADE-0.1.19.md](UPGRADE-0.1.19.md). The version notes
below are historical.

The historical 0.1.13 source merge retained Goodcover's Codex 0.156.1 and Claude Agent SDK
0.3.280, Plain OAuth and MCP catalog support, model reasoning capabilities,
and deployed apps on the QM origin. Upstream's per-turn skill directories replace
the old workspace skill projection. Owner credential sandboxes synchronize current
global skills into the same turn directories; room and personal skill files remain
excluded. Owner commands serialize synchronization and execution so concurrent
commands cannot replace scripts another command is still using. Usage timestamps
do not invalidate files, and skill revocation or failed writes remove stale trees.

The source build uses upstream Pi security.4 and patched HTTP, URI, IP parsing,
glob expansion, and Mermaid dependencies so production dependency audits pass.
The core image retains its build-time security audit.

The historical GPT-6.1 Sol addition upgraded the native Codex harness, since removed, to 0.159.2 for its model catalog.
The organization and personal defaults remain unchanged. Axios is pinned by the
lockfile at 1.20.0 so Slack dependencies pass the production security audit.

All three application services need source builds for this release, including the
admin UI's new Lit dependencies. The AWS MicroVM agent and Dockerfile are unchanged
from 0.1.12, so GC4 keeps sandbox version 4.0. Postgres 17 supports the new session
status, history indexes, and spend-reporting migrations. Preserve a database backup
before rollout; reverting service images does not reverse schema migrations.

`origin` points to `goodcover/qm`; `upstream` points to `yc-software/qm`. Only main
was imported. Use the upstream `update-qm` skill for updates and preserve merge
ancestry when landing sync PRs. Contributions upstream are optional and use the
`upstream-pr` workflow to exclude private deployment material.

GitHub Actions is disabled for this repository. The inherited release and package
publishing jobs also require `github.repository == 'yc-software/qm'`. Review the
remaining CI and publishing destinations before enabling Actions. This setup
does not add credentials to GitHub or publish any images or packages.
