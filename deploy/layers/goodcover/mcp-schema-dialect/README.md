# Claude MCP schema dialect

Release `0.1.11-gc.4` fixes a regression exposed by the Plain OAuth rollout.
Plain returns schemas with `definitions` and `#/definitions/...` references,
without `$schema`. Zod defaults to draft 2020-12 and fails to resolve those
references. Claude constructs all registered tools before each model call, so
one failing schema prevented unrelated Claude conversations from starting.

The Claude bridge now defaults to draft-7 for schemas with `definitions` and
without `$defs`. Explicit schema versions and modern `$defs` remain supported.
The fix retains argument validation; it does not replace schemas with permissive
objects or drop the affected tools.

The one-file patch is based on the production source commit
`51bf455ea414a58f70274284ce212142518e556a` and layers on gc.3. Apply
`schema-dialect.patch` to that baseline, copy `src/harness/claude-harness.ts`
into a build context alongside `core.Dockerfile`, and build for linux/amd64.
Image pins and release history remain in the sibling ops repository.

Validation:

- Reproduced conversion failures in 50 of 77 live Plain schemas before the fix.
- Converted all 77 schemas successfully with the corrected dialect.
- Claude harness tests: 18 passed, one root-only test skipped on macOS.
- Regression tests start a harness turn with legacy, modern and explicit schemas,
  accepting valid enum values and rejecting invalid or missing arguments.
- Source typecheck and lint passed.
- A real Claude subscription turn against the production dependencies loaded all
  77 Plain tools, called `plain_getMyUser` exactly once and replied `QM_SCHEMA_OK`.
  The canary had no Slack delivery and allowed only that profile read.

Plain was disabled during repair. Re-enable it only after the patched core is
healthy. If rolling back to gc.3, disable Plain first to avoid reintroducing the
failure. The client's OAuth connection and encrypted tokens can remain stored.

The deployed gc.4 bridge passed the same live Claude canary and matched the
expected file hash. Plain is re-enabled with all 77 tools.
