# Private-skill MCP feasibility results

This records the initial investigation. The skills have since been implemented
and imported; see [ROLLOUT.md](ROLLOUT.md) for current setup and validation.

Verified on 2026-09-15 against the existing QM AWS computer running Linux ARM64
and Node 24.16.0. No new infrastructure, database identities, or shared MCP
services were created. This validated the execution approach; the six workflow
skills had not yet been authored or imported at that stage.

## Live checks

All six connections passed tool discovery and a bounded read through MCPorter
inside the existing computer. Returned business data and credential values were
not included in the test summaries.

| Connection | Tools discovered | Successful read |
| --- | ---: | --- |
| Goodcover guides and blog posts | 9 | `list_blog_taxonomy` |
| Existing SigNoz MCP | 43 | `signoz_list_services`, limit 1, last hour |
| Datalake | 1 | `mysql_query`: `SELECT 1 AS qm_mcp_check` |
| ProdDB | 1 | `mysql_query`: `SELECT 1 AS qm_mcp_check` |
| Sentry | 8 initial tools | `find_organizations`; Goodcover visible |
| Google Search Console | 24 | `sites_list`; goodcover.com property visible |

Sentry ran with Seer disabled. No paid Seer calls or write queries were made.
SigNoz already has a native QM connection and can keep using it; its catalog
includes mutation tools, so it must not be classified as entirely read-only.

Tested package versions:

- `mcporter@0.13.13`
- `@benborla29/mcp-server-mysql@2.0.9`
- `@sentry/mcp-server@0.39.0`
- `search-console-mcp@2.1.1`

Packages installed successfully with lifecycle scripts disabled. HTTP servers
were called directly; the MySQL, Sentry, and Search Console MCP processes were
launched locally over stdio.

## Credentials and harnesses

Real QM turns using Codex (`gpt-5.6-sol`) and Claude Code (`claude-sonnet-5`)
each attached the existing ProdDB credential from QM's encrypted keychain to
execute a helper that ran `SELECT 1`. Both session transcripts contained the
successful tool result, not just an assistant claim. Test sessions were archived.

Search Console's existing account uses a Google service account. Its email and
private key worked as environment credentials on Linux and exposed the expected
property. No interactive Google login or Mac keychain dependency is needed for
this setup. The Mac's machine-encrypted configuration should not be copied.

Marketing and Sentry credentials also worked. Test credentials transferred to
the computer were placed in a private temporary directory and removed after
each probe. Permanent credential setup for the remaining skills was completed
during the subsequent rollout; these probes did not add those keychain entries.

## Private Git access

QM's own Git fetcher successfully fetched private `goodcover/agent-skills`,
branch `master`, commit `282091c3aae827945591974ca0720771ab386704`, using the
existing GitHub credential with HTTP Basic authentication. The ingestion planner
found 21 files and five eligible skills, with no exclusions.

The same credential failed for Git clone when sent as a Bearer header, despite
working against the GitHub API. Configure a repository-scoped Git service
credential through `authCredentialSlug`, using the Basic scheme and encoded
`x-access-token:<token>` value. Do not embed credentials in the repository URL.

No pack was registered or imported during this investigation. The subsequent
rollout completed live import and execution of the newly authored skills.
Do not mark organization skills `private: true` in frontmatter: QM excludes
those from organization imports, independently of repository visibility.

The current skills repository uses `{{baseDir}}` examples. The deployed QM
materializer preserves skill bodies and appends the pack directory; it does not
substitute that placeholder. New helpers need explicit path-resolution
instructions compatible with QM, verified after import.

## Database permissions

ProdDB's `reporting_prod` account has `USAGE` globally and only `SELECT` and
`SHOW VIEW` on `proddb`, `store`, and `etl_store`. Its read-only boundary is
enforced by the database.

Datalake connectivity works, but its current account is `root`. StarRocks
`SHOW GRANTS` confirmed the root role. Disabling writes in the MySQL MCP does
not turn that account into a database-enforced read-only identity. Dan subsequently confirmed that the existing Datalake account should remain in
use because read-only identities do not work for this setup. No database
identity or permissions were changed during rollout.

## Computer replacement

QM excludes `node_modules` from home snapshots, including installations under
the workspace. A persistent package manifest alone is insufficient: the skill
launcher must restore missing dependencies using its pinned lockfile.

A clean installation in an empty temporary directory, using only the tested
`package.json` and `package-lock.json`, passed `npm ci --ignore-scripts` and
successfully loaded MCPorter. The production computer was not replaced or
restarted, so replacement plus skill bootstrap remains an end-to-end rollout
check. The nonsecret test installation in `/root/workspace/.qm-mcp-check` was removed
after the imported runtime passed rollout checks.

## Work identified by this investigation

Items 1, 2, 3, and 5 were completed during rollout. A production computer
replacement in item 4 has not been forced; the rollout tested an isolated
dependency restore and live bootstrap on the existing computer.

1. Add the private skills and pinned, repeatable MCP launcher in `agent-skills`.
2. Configure private Git authentication and the remaining authorized keychain
   entries, then import the selected skills.
3. Resolve helper paths and verify a skill invocation through each harness.
4. Verify dependency bootstrap after computer replacement when that operation
   is appropriate for the running instance.
5. Preserve the existing Datalake account, as confirmed by Dan.

The tested approach needs no additional always-on service and no QM core code
change for MCP execution. Skill authoring, configuration, and rollout checks
were subsequently completed as recorded in [ROLLOUT.md](ROLLOUT.md).
