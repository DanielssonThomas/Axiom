import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export interface ClaudeProfile {
  program: string;
  home: string;
  userHome: string;
  workspace: string;
  /** Explicit native provider and session settings. Ambient credentials are excluded. */
  environment?: Readonly<Record<string, string>>;
  launch?: ClaudeLauncher;
}

export type ClaudeLauncher = (
  profile: ClaudeProfile,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => { program: string; args: readonly string[]; env: NodeJS.ProcessEnv };

export const subscriptionArguments = ["--restricted", "--settings", '{"forceLoginMethod":"claudeai"}'] as const;

export function invokeClaude(
  profile: ClaudeProfile, args: readonly string[], signal = AbortSignal.timeout(30_000), input?: string,
): Promise<{ code: number; stdout: string }> {
  if (![profile.program, profile.home, profile.userHome, profile.workspace].every(isAbsolute)) {
    throw new Error("Use absolute paths for the executable, profile roots, and workspace.");
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const ownsProcessGroup = process.platform !== "win32";
    const env = {
      PATH: process.env.PATH, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1", ...profile.environment, HOME: profile.userHome, CLAUDE_CONFIG_DIR: profile.home,
    };
    const launch = profile.launch?.(profile, args, env) ?? { program: profile.program, args, env };
    const child = spawn(launch.program, launch.args, {
      cwd: profile.workspace, shell: false, detached: ownsProcessGroup, windowsHide: true, env: launch.env,
    });
    let failure: Error | undefined;
    function terminate() {
      if (child.pid === undefined) return;
      try {
        if (ownsProcessGroup) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          failure ??= new Error("The Claude process group could not be stopped.", { cause: error });
        }
      }
    }
    const stdout: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        failure ??= new Error("The Claude output exceeded its buffer limit.");
        terminate();
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.resume();
    child.on("error", (error) => { failure ??= error; });
    child.on("exit", terminate);
    child.on("close", (code) => {
      signal.removeEventListener("abort", terminate);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code === null) reject(new Error("The Claude process ended without an exit status."));
      else resolve({ code, stdout: Buffer.concat(stdout).toString("utf8") });
    });
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
    child.stdin?.on("error", () => { /* A native administrative command may exit without reading stdin. */ });
    child.stdin?.end(input);
  });
}

export async function hasClaudeSubscription(profile: ClaudeProfile, signal: AbortSignal): Promise<boolean> {
  const { code, stdout } = await invokeClaude(profile, [...subscriptionArguments, "auth", "status", "--json"], signal);
  if (code !== 0) return false;
  try {
    const status = JSON.parse(stdout);
    return status?.loggedIn === true && status.authMethod === "claude.ai"
      && status.apiProvider === "firstParty" && status.configDirectory === profile.home;
  } catch {
    return false;
  }
}

export async function claudeVersion(profile: ClaudeProfile, signal?: AbortSignal): Promise<string | undefined> {
  const { code, stdout } = await invokeClaude(profile, ["--version"], signal);
  return code === 0 ? /^(\S+) \(Claude Code\)\s*$/.exec(stdout)?.[1] : undefined;
}

export async function nativeJson(profile: ClaudeProfile, args: readonly string[], signal?: AbortSignal): Promise<unknown> {
  const { code, stdout } = await invokeClaude(profile, [...args, "--json"], signal);
  if (code !== 0) throw new Error("The native Claude operation failed.");
  return JSON.parse(stdout) as unknown;
}
