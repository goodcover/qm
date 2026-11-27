# Antigravity model login

A QM instance can serve Gemini through Google's Antigravity CLI (`agy`), the way it serves Claude through a company Claude subscription. One Google login, signed in once on the core host, serves every authorized company-model user who selects Gemini 4 Neon. Only the model login is shared. Each turn keeps its own QM identity, scope, credentials, approvals and tools.

## Setup

1. Make sure your Google plan allows this login to serve more than one person. That is a rollout prerequisite, not something QM checks.
2. On the core host, install `agy` at `~/.local/bin/agy` (the installer's default) for the user that runs core, and install bubblewrap (`bwrap`) on `PATH`.
3. Sign in once into a dedicated profile directory, for example by running `agy acp --disable-telemetry --login` inside bubblewrap with `HOME` set to that directory. Don't use the profile interactively; its own history is visible to agy, though not to the model. It must be owned by the core user, mode `700`, and not a symbolic link.
4. Start core with `ANTIGRAVITY_PROFILE` set to that directory's absolute path.

Gemini 4 Neon (`antigravity/gemini-4-neon`) then appears wherever company models do. The organization's model allowlist and defaults apply as for any other company model, and the default model does not change. People on a personal AI account do not get it. The inner browser agent refuses it, as it refuses Claude subscription access.

QM never reads, copies or stores the login. It mounts the profile read-only.

## What a turn does

Each turn starts its own `agy acp` inside bubblewrap. The CLI sees its binary, the host's libraries, DNS and CA files, a private `/tmp`, a read-only `/work`, and the profile as `HOME`. The profile is the lower layer of an overlay whose writes go to a tmpfs that disappears with the turn. Concurrent turns and later turns never see each other's Antigravity conversations, artifacts or refreshed tokens, and the profile itself is never written. There is no shell and no view of the host's home directory.

`/work` holds one fixed custom agent definition. It drops Antigravity's default prompt and its file, command, web and subagent tools, and allows only QM's MCP server. Antigravity still adds its inert `list_resources`, `read_resource` and `manage_task` tools. The network namespace is shared with the host, because the CLI reaches Google directly.

QM's system prompt goes to the session through the Antigravity system prompt extension in `session/new`. QM's transcript goes in the first prompt, together with any documents, as text. QM serves the turn's tools from a loopback MCP server with a random port and bearer secret, and both die with the turn. When Antigravity calls a tool, QM hands the call to its own agent loop for the person whose turn it is, so that person's approvals, credentials and policies apply. QM then returns the result to Antigravity's waiting MCP request. A message that steers a running turn goes into the live session.

QM approves Antigravity's permission prompts only for the tools it serves. Any other tool start or permission prompt ends the turn and kills the process, and so does an aborted run. If the process dies, the turn reports its exit status. Usage is reported per prompt and priced at zero, since the Google plan pays for it.

## Limits

- Each turn starts a new Antigravity session, so earlier turns are not read from Antigravity's prompt cache.
- A QM tool that runs longer than Antigravity's MCP request timeout makes Antigravity give up on the call. QM then restarts the turn from its own transcript.
- Images in earlier turns are shown as `[image]`.
