import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const ANTIGRAVITY_MCP_SERVER = "qm";
export const ANTIGRAVITY_WORKSPACE = "/work";
const AGENT = "qm";
const SANDBOX_HOME = "/home/agy";
const HOST_LIBRARIES = ["/lib", "/lib64", "/usr/lib", "/usr/lib64"];
const HOST_FILES = ["/etc/resolv.conf", "/etc/hosts", "/etc/ssl", "/etc/pki", "/etc/ca-certificates"];

const AGENT_DEFINITION = `---
name: ${AGENT}
description: Runs one QM turn with only the tools QM serves.
mainAgent: true
subagent: false
hidden: true
inheritCustomizations: false
excludeDefaultComponents: true
tools: []
mcpServers: [{name: ${ANTIGRAVITY_MCP_SERVER}}]
---
# QM
Use only the tools QM serves.
`;

export interface AntigravityProcess {
  child: ChildProcessWithoutNullStreams;
  cleanup: () => void;
}

function assertOwnerOnlyProfile(profile: string): void {
  const stat = lstatSync(profile);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error(
      "ANTIGRAVITY_PROFILE must be a directory, not a symbolic link, owned by the user running core with mode 700",
    );
}

function boundaryArgs(cli: string, profile: string, workspace: string): string[] {
  return [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--new-session",
    "--die-with-parent",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--setenv",
    "HOME",
    SANDBOX_HOME,
    "--setenv",
    "PATH",
    "/bin",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--ro-bind",
    cli,
    "/bin/agy",
    ...[...HOST_LIBRARIES, ...HOST_FILES].flatMap((path) => ["--ro-bind-try", path, path]),
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--proc",
    "/proc",
    "--overlay-src",
    profile,
    "--tmp-overlay",
    SANDBOX_HOME,
    "--ro-bind",
    workspace,
    ANTIGRAVITY_WORKSPACE,
    "--chdir",
    ANTIGRAVITY_WORKSPACE,
  ];
}

export function launchAntigravity(profile: string): AntigravityProcess {
  assertOwnerOnlyProfile(profile);
  const cli = join(homedir(), ".local", "bin", "agy");
  const workspace = mkdtempSync(join(tmpdir(), "qm-antigravity-"));
  const agents = join(workspace, ".agents", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, `${AGENT}.md`), AGENT_DEFINITION);
  const child = spawn(
    "bwrap",
    [...boundaryArgs(cli, profile, workspace), "--", "/bin/agy", "acp", "--disable-telemetry", "--agent", AGENT],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  return { child, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}
