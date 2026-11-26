# Antigravity personal route

A QM core running on its owner's own Linux workstation can serve that person's turns through Google's Antigravity CLI (`agy`), using the Antigravity login already on the machine. It is a personal route only: no teammate, organization default, fallback, browser agent or automated turn reaches it.

## Setup

1. Install `agy` at `~/.local/bin/agy` for the user that runs core, and install bubblewrap at `/usr/bin/bwrap`. The boundary binds the glibc libraries from `/usr/lib64` and the CA bundle at `/etc/ssl/certs/ca-bundle.crt`, the Fedora layout.
2. Sign in once with `agy acp --disable-telemetry --login`, run inside a bubblewrap boundary whose `HOME` is `~/.local/share/qm-antigravity/profile`. That directory must be owned by the same user, with mode `700`, and must not be a symbolic link.
3. Start core with `ANTIGRAVITY_OWNER` set to the owner's QM principal id.
4. The owner sets their AI access to a personal account (`POST /v1/user-model-auth/account` with `{"account":"personal"}`). In their personal scope, the runtime listing then offers `antigravity/gemini-4-neon`. When the Antigravity login is the owner's only personal login, it also serves their turns that name no model.

QM never reads, copies or stores the Antigravity login. It only mounts the profile as the CLI's home inside the boundary.

## What a turn does

Each turn starts `agy acp` inside bubblewrap. The CLI sees only its own binary, a few glibc libraries, DNS and CA files, a private `/tmp`, the profile as `HOME` and a read-only `/work`. There is no shell and no view of the host's home directory. `/work` holds one fixed custom agent definition. It drops Antigravity's default prompt and its file, command, web and subagent tools, and allows only QM's MCP server. Antigravity still adds its inert `list_resources`, `read_resource` and `manage_task` tools. The network namespace is shared with the host, because the CLI reaches Google directly.

QM's system prompt goes to the session through the Antigravity system prompt extension in `session/new`. QM's transcript goes in the first prompt. QM serves the turn's tools from a loopback MCP server. Each turn's server has a random port and bearer secret, and both die with the turn. When Antigravity calls a tool, QM hands the call to its own agent loop, so the usual approvals and policies apply. QM then returns the result to Antigravity's waiting MCP request.

QM approves Antigravity's permission prompts only for the tools it serves. Any other tool start, permission prompt or client request ends the turn and kills the process, and so does an aborted run. If the process dies, the turn reports its exit code or signal. Usage is reported at the end of each prompt and priced at zero, since the owner's Antigravity plan pays for it.

## Limits

- Each turn starts a new Antigravity session. Earlier turns arrive as text in the first prompt, so they are not read from Antigravity's prompt cache.
- A message that steers a running turn restarts the session from QM's transcript.
- Each turn leaves an Antigravity conversation in the owner's profile.
- A QM tool that runs longer than Antigravity's MCP request timeout makes Antigravity give up on the call. QM then restarts the turn from its own transcript.
- Images in earlier turns are shown as `[image]`. Document inputs are refused.
