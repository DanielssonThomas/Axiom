import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

export interface ClaudeProfile {
  program: string;
  home: string;
  userHome: string;
  workspace: string;
  /** Explicit native provider and session settings. Ambient credentials are excluded. */
  environment?: Readonly<Record<string, string>>;
}

export function invokeClaude(
  profile: ClaudeProfile, args: readonly string[], signal = AbortSignal.timeout(30_000), input?: string,
): Promise<{ code: number; stdout: string }> {
  if (![profile.program, profile.home, profile.userHome, profile.workspace].every(isAbsolute)) {
    throw new Error("Use absolute paths for the executable, profile roots, and workspace.");
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(profile.program, [...args], {
      cwd: profile.workspace, shell: false, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
      signal, killSignal: "SIGKILL", windowsHide: true,
      env: {
        PATH: process.env.PATH, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1", ...profile.environment, HOME: profile.userHome, CLAUDE_CONFIG_DIR: profile.home,
      },
    }, (error, stdout) => {
      if (signal.aborted) reject(signal.reason);
      else if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout });
    });
    child.stdin?.on("error", () => { /* A native administrative command may exit without reading stdin. */ });
    child.stdin?.end(input);
  });
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
