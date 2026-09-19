# Plain OAuth for MCP

QM supports Plain's authorization-code flow with PKCE and the required
`openid offline_access` scopes. Authorization and token requests include the
resource `https://mcp.plain.com/mcp`. Client secrets and user access/refresh
tokens use the existing encrypted connector configuration and keychain.

Register an OAuth client through the registration endpoint advertised by
`https://signin.auth.plain.com/.well-known/oauth-authorization-server`, using
`client_secret_post`, authorization-code and refresh-token grants, and redirect:
`https://qm.gc4.infra.goodcover.com/v1/connectors/oauth/plain/callback`.
Keep the registration response in ops' ignored `.local/` directory.

Configure the client through the signed admin API:
`PUT /v1/admin/scopes/org%3Agoodcover/connectors`, with `provider: "plain"`,
`clientId`, `clientSecret`, both scopes, the redirect allowlist, and `enabled: true`.
Each user connects Plain from `/keychain`; the web UI starts the flow through
`POST /api/connectors/plain/start`.

Register the MCP server with `PUT /admin/api/mcp-servers/plain`:

```json
{
  "name": "Plain",
  "url": "https://mcp.plain.com/mcp",
  "auth": "oauth",
  "credentialScope": "per-user",
  "credentialHost": "mcp.plain.com",
  "credentialAccountType": "default",
  "readOnly": false,
  "enabled": true
}
```

The registering admin supplies the OAuth identity for tool discovery; each call
uses the requesting user's refreshed keychain token. Users without a connection
receive a connect-account error. `readOnly: false` keeps Plain's write-capable
catalog out of read-only execution contexts. Registering with `enabled: false`
and `validate: false` can stage the configuration before consent. Re-save with
validation after connecting to discover tools immediately.

Release `0.1.11-gc.2` layers only these changes on the existing gc.1 images.
`plain-oauth.patch` includes the required per-user MCP wiring, based on upstream
commit `51bf455ea414a58f70274284ce212142518e556a`. Apply it to that baseline,
then build the two Dockerfiles with the patched tree as their build context.
The patch does not overlap the gc.1 deployed-app origin changes.

Image pins, release history and rollback live in `../ops/gc4/packages/qm/`.
Rollback using the gc.2 release entry’s `baseServices` in its `images.json`; do not restart
core during active runs. OAuth configuration and encrypted keychain data remain
in Postgres when rolling back; gc.1 cannot use the new OAuth MCP auth mode.

Validation: 73 affected core tests and 8 admin proxy tests, source typecheck and
lint, plus imports against the production baseline image. Production consent, live profile read, user isolation and token refresh passed.
The subsequent `../plain-tool-catalog/` release exposes all 77 tools.
