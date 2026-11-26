import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeLauncher } from "@axiom/claude-adapter";

export const sandboxEndpoint = "http://127.0.0.1:43181";
const bridge = fileURLToPath(new URL("../dist/sandbox-bridge.js", import.meta.url));
const node = realpathSync(process.execPath);
const system = ["/usr/bin", "/usr/lib", "/usr/lib64"];

function within(path: string, root: string) {
  const offset = relative(root, path);
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(".." + sep));
}

/** Reject paths visible via the system runtime mounts. All verifier inputs must stay private. */
export function assertPrivateBenchmarkPath(path: string) {
  if (!isAbsolute(path) || system.some((root) => within(path, root) || within(root, path))) {
    throw new Error("The verifier path overlaps a system runtime mount.");
  }
}

export function launchClaudeSandbox(socket: string, bundle?: string): ClaudeLauncher {
  return (profile, args, env) => {
    const home = realpathSync(dirname(profile.home));
    const workspace = realpathSync(profile.workspace);
    for (const path of [home, workspace, ...(bundle ? [bundle] : [])]) assertPrivateBenchmarkPath(path);
    const environment = {
      PATH: "/axiom/bin:/usr/bin", HOME: profile.userHome, CLAUDE_CONFIG_DIR: profile.home,
      TMPDIR: "/tmp", ANTHROPIC_BASE_URL: sandboxEndpoint, ANTHROPIC_API_KEY: "axiom-loopback",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1",
      DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", GIT_CONFIG_NOSYSTEM: "1",
    };
    return {
      program: "/usr/bin/bwrap", env: {},
      args: [
        "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/etc",
        ...system.flatMap((path) => ["--ro-bind-try", path, path]),
        "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
        "--bind", workspace, workspace, "--bind", home, home,
        ...(bundle ? ["--ro-bind", bundle, bundle] : []),
        "--ro-bind", socket, "/axiom/provider.sock", "--ro-bind", bridge, "/axiom/bridge.mjs",
        "--ro-bind", node, "/axiom/bin/node", "--ro-bind", realpathSync(profile.program), "/axiom/claude",
        ...Object.entries(environment).flatMap(([name, value]) => ["--setenv", name, value]),
        "--chdir", workspace, "/axiom/bin/node", "/axiom/bridge.mjs", "/axiom/claude", ...args,
      ],
    };
  };
}
