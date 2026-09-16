# Commander on QM

Deployed 2026-09-15 to Dan's existing Linux ARM64 QM computer. ARM64 and
`aarch64` name the same architecture. No infrastructure was provisioned.

## Installation and credentials

The private `goodcover/agent-skills` Commander skill contains a Python stdlib
installer and release manifest. The initial Commander rollout added it to the
six MCP skills in pack `8fd9d1bf-06d4-4dad-b456-f7daee53f143`, at commit
`1950404ac36a5e829cc5c72468a410da477fb8cf`. Orca was added later. See the
[shared pack state](../mcp/ROLLOUT.md#repository-and-pack) for the verified
eight-skill selection and pin. Preserve all selected skills during updates.
The implementation was merged in [agent-skills PR 3](https://github.com/goodcover/agent-skills/pull/3);
[PR 4](https://github.com/goodcover/agent-skills/pull/4) clarified file-credential handling after live verification.

Read the literal relative `skills/commander/SKILL.md` path before invoking its
installer so QM materializes the pack assets. Run:

```sh
python3 skills/commander/scripts/install_qm.py
~/.local/bin/commander --help
```

The installer stores a checksummed native executable and FoundationDB client
under `~/.local/share/goodcover-commander/<sha256>/`, with a wrapper linked from
`~/.local/bin/commander`. The wrapper sets `LD_LIBRARY_PATH` and defaults
`COMMANDER_HOME` to `~/.commander`. These files are included in normal home
snapshots; rerun the installer if missing. A whole computer replacement was not
performed during verification.

Dan's existing QM encrypted keychain holds two added credentials:

- `commander-maven`: existing Maven URL, username, and password, injected as
  `GC_MAVEN_REPO_URL`, `GC_MAVEN_USERNAME`, and `GC_MAVEN_PASSWORD`. Needed only
  when downloading a missing or corrupt Commander executable.
- `commander-fdb`: prod and stage cluster files, materialized under
  `~/.commander/fdb/` for a credential-bearing execute call. Source files were
  compared in memory with the live GC4 configmaps before saving.

Credential values are not stored in this repository. Production gabs calls use
existing GC4 cluster DNS and direct routing. Kubernetes, Temporal, and browser
workflows have additional prerequisites described in the skill; those were not
configured or exercised by this rollout.

## Native artifact

Published to the existing private Maven repository:

- Coordinate: `com.goodcover.commander:commander-native-linux-aarch64:20260915-8b9aad758702`
- Also published as `commander-native-linux-aarch64:latest` after live checks.
- Size: 175,377,496 bytes.
- SHA256: `f3adb4b0c513741d473e31b7426ba70b6c73a33786ae18c7968b5b284009cd23`.
- FoundationDB C client: official 7.3.69 `libfdb_c.aarch64.so`, SHA256
  `151280c0920484ec455444e5bb688c9219babe67f07d320e155adb2eb8e55b8e`.

The build used Dan's already-running ARM64 Podman machine on the Mac. The
builder was `ghcr.io/graalvm/native-image-community:25-ol9`, digest
`sha256:a5eb869651af2aeeea0e9c676d034ecce4d803a4d38020ca526e007abc7ad200`.
It ran without network access, with 3 CPUs and 12 GB memory; native-image used
10 GB heap and `-march=compatibility`. Other native-image arguments came from
Commander's existing `build.mill`. Build time was 3m 5s.

The portable input JAR was extracted from the existing ECR image
`008562636938.dkr.ecr.us-west-2.amazonaws.com/goodcover/commander:latest-v2`:

- App layer: `sha256:6e9f4a9a3f8b48299b0bce57d78501ae3309b984886554daba495bfe8215e9ed`.
- Input: `/lib/backend.jar`, 412,663,381 bytes.
- JAR SHA256: `8b9aad758702f103e0d8b53b2aab759bbab12e428f0f723c1cf0aa48acada1a3`.

This is a native rebuild of that published application JAR, not a build of the
current Commander source checkout. Build inputs, outputs, and builder metadata
remain in `~/Library/Caches/goodcover-commander` locally. Operator build and
publication helpers are in ignored `.local/`; the deployed installer and
manifest are tracked in `agent-skills`.

Recurring ARM CI has not been added: existing Jenkins workers are AMD64.
Future releases need an ARM build and publication, followed by updating the
pinned skill manifest. The existing Commander build already supports the
`linux-aarch64` artifact name.

## Validation

- 17 offline installer tests passed, covering checksums, architecture, credential
  handling, restore, atomic replacement, and concurrent installation.
- Skill validation and independent installer review passed.
- Native installation and CLI help passed on the actual QM ARM64 computer.
- Production `cmds moratorium-list --output json` returned 136 entries.
- Production `events dump --type B1Policy --output json` for a fabricated,
  nonexistent ID returned `[]` with exit 0, exercising the FoundationDB client.
- No business writes were performed.

The owned Podman build container was removed after saving its build log. The
unused JVM fallback JAR was removed from QM; the native installation remains.

## Harness verification

Codex (`gpt-5.6-sol`) and Claude Code (`claude-sonnet-5`) both used the imported
installer and successfully executed production moratorium and FoundationDB
reads with the caller's keychain. Recorded tool output showed exit 0, 136
moratoriums, and zero events for the fabricated ID.

- Codex run: `abb0438f-52f0-492d-a3a5-951fe75c4f7e`; session
  `df25f00b-e1e0-40c1-8f77-c706c0aab5e8`. Final status `ok`; the test client's
  five-minute request timeout preceded the recorded successful completion.
- Claude run: `d5782263-6b85-4592-b9b3-611901ccef9f`; session
  `189e3bc4-f8d0-4db0-a4c2-ec0154b9bd11`. All requested reads passed. The harness
  initially inspected part of a file-credential setup script; it was steered
  to source without displaying it, and the skill now explicitly forbids
  inspecting encoded credential content. Its later recursive cleanup command
  required approval. No approval was granted: the exact owned credential files
  were removed individually, followed by links and empty directories.

Both verification sessions were archived. Claude's surrounding test turn ended
in `pending_approval` for cleanup, so this is a pass for the requested connection
checks, not an assertion that its whole test turn completed normally.
