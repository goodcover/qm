# Goodcover MCP access through private skills

Status: implemented and imported; see [rollout](ROLLOUT.md) and [feasibility results](RESULTS.md). Use QM's existing agent computers; the separate EKS
MCP workload proposal is withdrawn. No new workload, volume, or networking
resources have been provisioned.

## Architecture

QM's native MCP registry accepts HTTP servers. This restriction does not apply
to commands run inside its agent computers: both Codex and Claude Code have QM's
execute tool, and those computers have Node 24, Python, and direct GC4 access.
A private skill can invoke an MCP command-line client such as MCPorter, which
connects to an HTTP endpoint or launches an existing stdio MCP process locally.
The process runs on demand inside the existing computer.

Skills are instructions plus executable helpers; a SKILL.md alone does not run
an MCP server. Pin the MCP client and server dependencies and make their setup
repeatable after computer replacement. Do not assume a machine-global install
survives QM's home-snapshot restore. Even workspace `node_modules` is excluded;
use a bootstrap command with a pinned lockfile to restore missing dependencies.

## Connections

| Connection                      | Implementation                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Goodcover guides and blog posts | Existing production HTTP MCP at `https://www.goodcover.com/mcp`; skill documents content workflows                          |
| SigNoz                          | Existing `http://signoz-mcp.signoz.svc.cluster.local:8000/mcp`; already registered in QM and verified, no server to install |
| Datalake                        | Launch the pinned MySQL MCP in the computer against StarRocks on port 9030                                                  |
| ProdDB read-only                | Launch the pinned MySQL MCP using a verified read-only database identity                                                    |
| Sentry                          | Official Sentry MCP through its supported local/token or remote/OAuth path; validate existing credential permissions        |
| Search Console                  | Existing search-console-mcp implementation launched locally; validate Google authentication portability and renewal         |

## Private repository and credentials

Put Goodcover workflow skills and small launchers in `../agent-skills`. Connect
the private repository as a QM skill pack and import the selected skills.
Keep credentials in QM's encrypted keychain and make them available only under
the calling scope's existing authorization. Git holds credential names and
nonsecret configuration only. Private Git access also needs a scoped credential
acceptable to QM's skill-pack fetcher; do not embed a token in the repository URL.

The current local Datalake setup uses StarRocks root with MCP write operations
disabled. Those flags are not database authorization. Dan confirmed the existing Datalake account should remain in use. ProdDB's
reporting grants were verified as read-only. Preserve
MCP/server permission boundaries rather than relying on skill prose to restrict
SQL or mutating tools.

## Verification and maintenance

All six connections passed bounded reads through the imported skills in Codex
and Claude Code. Private Git fetching, keychain delivery, Linux ARM64 bootstrap,
and isolated dependency restoration were verified. See [ROLLOUT.md](ROLLOUT.md)
for the pinned commit, credential names, loading instructions, and test evidence.

The pack stays pinned to a reviewed commit. Update that pin and import/sync after
future changes. Keep the existing Datalake account as Dan confirmed. An actual
computer replacement was not forced; verify that lifecycle when the instance
next needs replacement.

## Tradeoff

For connections accessed through skills, the harness invokes a command through
execute instead of receiving each remote MCP tool as a native harness tool.
QM audits the command invocation; the MCP client's result and server permissions
still govern the operation. Each scope may incur a small process startup cost.
This uses existing computer capacity rather than adding a shared always-on MCP
service. Keep the native SigNoz connection that already works.
