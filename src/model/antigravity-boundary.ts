import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { errMessage, swallow } from "../util/errors.ts";

export const ANTIGRAVITY_MCP_SERVER = "qm";
export const ANTIGRAVITY_WORKSPACE = "/work";
const AGENT = "qm";
const BWRAP = "/usr/bin/bwrap";
const SANDBOX_HOME = "/home/agy";
const GLIBC = [
  "ld-linux-x86-64.so.2",
  "libc.so.6",
  "libdl.so.2",
  "libm.so.6",
  "libpthread.so.0",
  "libresolv.so.2",
  "librt.so.1",
];

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
  exited: Promise<string>;
}

function antigravityCli(): string {
  return join(homedir(), ".local", "bin", "agy");
}

export function antigravityProfile(): string {
  return join(homedir(), ".local", "share", "qm-antigravity", "profile");
}

function assertOwnerOnlyProfile(profile: string): void {
  const stat = lstatSync(profile);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error(
      `The Antigravity profile ${profile} must be a directory, not a symbolic link, owned by this user with mode 700`,
    );
}

function boundaryArgs(profile: string, workspace: string): string[] {
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
    "XDG_CONFIG_HOME",
    `${SANDBOX_HOME}/.config`,
    "--setenv",
    "PATH",
    "/bin",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--ro-bind",
    antigravityCli(),
    "/bin/agy",
    "--symlink",
    "usr/lib64",
    "/lib64",
    ...GLIBC.flatMap((lib) => ["--ro-bind", `/usr/lib64/${lib}`, `/usr/lib64/${lib}`]),
    "--ro-bind-try",
    "/etc/resolv.conf",
    "/etc/resolv.conf",
    "--ro-bind-try",
    "/etc/hosts",
    "/etc/hosts",
    "--ro-bind",
    "/etc/ssl/certs/ca-bundle.crt",
    "/etc/ssl/certs/ca-bundle.crt",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--proc",
    "/proc",
    "--bind",
    profile,
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
  const workspace = mkdtempSync(join(tmpdir(), "qm-antigravity-"));
  const agents = join(workspace, ".agents", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, `${AGENT}.md`), AGENT_DEFINITION);
  const child = spawn(
    BWRAP,
    [...boundaryArgs(profile, workspace), "--", "/bin/agy", "acp", "--disable-telemetry", "--agent", AGENT],
    { stdio: ["pipe", "pipe", "pipe"], env: {} },
  );
  child.stderr.on("data", (data: Buffer) => console.error(`[antigravity] ${data.toString().trimEnd()}`));
  const exited = new Promise<string>((resolve) => {
    const done = (how: string) => {
      rmSync(workspace, { recursive: true, force: true });
      resolve(how);
    };
    child.once("exit", (code, signal) => done(signal ? `was killed by ${signal}` : `exited with code ${code}`));
    child.once("error", (error) => {
      if (child.pid === undefined) done(`could not start ${BWRAP}: ${errMessage(error)}`);
      else swallow("antigravity: the boundary process reported an error", error);
    });
  });
  return { child, exited };
}
