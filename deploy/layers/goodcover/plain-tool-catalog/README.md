# Full Plain MCP catalog

Release `0.1.11-gc.3` raises the per-server MCP tool limit from 64 to 128.
Plain returned 77 tools during live integration; the old cap omitted thread
search and other useful tools. This layer replaces only the MCP tool service
in the gc.2 core image. The web UI continues using gc.2.

Apply `catalog.patch` after `../plain-oauth/plain-oauth.patch`, then copy the
patched `src/mcp/mcp-tool-service.ts` into a build context alongside
`core.Dockerfile`. Build for linux/amd64. Current image pins and release history
remain in `../ops/gc4/packages/qm/images.json`.

The regression test discovers 77 tools and calls the last one. Typecheck and
lint cover the source change. Rollback uses the current release's baseServices
image pins, preserving the preceding OAuth and deployed-app origin changes.

Live verification: all 77 tools are registered in production, including thread
search. A profile read succeeded, an unconnected principal was rejected, and
token refresh persisted a usable replacement token. All workloads are healthy.
