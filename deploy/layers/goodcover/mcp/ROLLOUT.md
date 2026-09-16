# Goodcover MCP skill rollout

Date: 2026-09-15

The six skills are implemented in `goodcover/agent-skills` and imported into
QM as an internal organization pack. The existing SigNoz native MCP connection
remains available. No infrastructure or database permissions were changed.

## Repository and pack

- Repository: https://github.com/goodcover/agent-skills
- Pull request: https://github.com/goodcover/agent-skills/pull/2
- Initial rollout commit: `c4f7eb9076f403f12918c565a3682abf7c86b738`
- QM pack ID: `8fd9d1bf-06d4-4dad-b456-f7daee53f143`
- Initially imported: `goodcover-content`, `signoz`, `datalake`, `proddb-readonly`,
  `sentry`, `google-search-console`
- Git authentication: repository-scoped broker credential
  `goodcover-agent-skills-git`, HTTP Basic, no agent grants.

On 2026-09-16, the live pack was pinned to
`39b96de3d74c34dfe5564a580d774d352f49bc25`. Its eight selected skills are the six
above plus `commander` and `orca-cli`. After reviewing future repository changes,
read the current pack metadata and preserve all selected skills when updating
its commit and importing through QM's skill-pack administration API. The initial
rollout commit and subset above are historical records.

## Runtime and credentials

`shared/mcp/run.py` installs the exact lockfile into a content-addressed cache,
serializes concurrent installations, and restores dependencies when missing.
`run.mjs` uses MCPorter for HTTP and stdio calls. Temporary configuration holds
credential environment references; credential values are not stored in Git or
in that configuration. Interrupted launcher processes terminate their child
process groups.

Credentials remain in Dan's personal encrypted keychain:

| Connection | Keychain service | Environment |
| --- | --- | --- |
| Marketing | `goodcover-marketing` | `GOODCOVER_MARKETING_AUTHORIZATION` |
| ProdDB | `mcp_server_mysql_proddb` | `PRODDB_MYSQL_PASSWORD` |
| Sentry | `goodcover-sentry` | `SENTRY_ACCESS_TOKEN` |
| Search Console | `goodcover-search-console` | `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` |

SigNoz uses the existing internal service. Datalake uses the existing
cluster-local account, as Dan confirmed; no new credential or database identity
was required. ProdDB retains database-enforced read-only grants.

## QM loading behavior

QM initially writes only skill entrypoints. To materialize the shared runtime,
read a literal relative path such as `skills/datalake/SKILL.md` using QM's file
reader, or execute `cat skills/datalake/SKILL.md` without credentials. Reading
via an absolute path or a shell loop does not trigger the lazy loader. The six
skills include this instruction.

Resolve the appended pack path against the computer workspace root. For this
instance the launcher is
`/root/workspace/skills/.packs/8fd9d1bf-06d4-4dad-b456-f7daee53f143/shared/mcp/run.py`.

## Validation

- Six skill manifests validated and standalone package mappings checked.
- Five offline regression tests passed: concurrent installation and restoration,
  interrupted installation, descendant cleanup, credential/cleanup handling, and
  preservation of query data while removing the known Search Console update footer.
- Independent review completed, including literal credential interpolation and
  QM lazy materialization behavior.
- Fresh Linux ARM64 dependency bootstrap and Datalake `SELECT 1` passed.
- All six bounded reads passed through the imported pack in Codex and Claude
  Code. Recorded tool results were checked; the final Claude run completed
  without quarantine or pending approval. Test sessions were archived.

An actual production computer replacement was not forced. Missing-dependency
restoration is covered by an isolated restore test, and bootstrap was exercised
on the existing Linux computer.

The Search Console MCP appends a package-upgrade instruction to query results.
The launcher removes only that exact known footer; it preserves query data,
error fields, and other notices. QM security screening remains enabled.
