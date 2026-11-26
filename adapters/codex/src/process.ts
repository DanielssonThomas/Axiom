import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export interface CodexProfile {
  program: string;
  home: string;
  userHome: string;
  workspace: string;
  /** Only this explicit environment is forwarded in addition to the profile roots and PATH. */
  environment?: Readonly<Record<string, string>>;
}

interface NativeOptions {
  signal?: AbortSignal;
  input?: string;
  /** Capture short administrative diagnostics in memory. Turn stderr is always discarded. */
  captureStderr?: boolean;
  /** Opt in to experimental app-server methods during JSON-RPC initialization. */
  experimentalApi?: true;
  onLine?: (line: string, write: (value: unknown) => void, end: () => void) => void;
}

export async function runCodex(profile: CodexProfile, args: readonly string[], options: NativeOptions = {}) {
  if (!isAbsolute(profile.program)) throw new Error("Use an absolute path to the Codex executable.");
  const signal = options.signal ?? AbortSignal.timeout(20_000);
  signal.throwIfAborted();
  const group = process.platform !== "win32";
  const child = spawn(profile.program, args, {
    cwd: profile.workspace, shell: false, detached: group, windowsHide: true,
    env: { PATH: process.env.PATH, ...profile.environment, HOME: profile.userHome, CODEX_HOME: profile.home },
    stdio: ["pipe", "pipe", options.captureStderr ? "pipe" : "ignore"],
  });
  const input = child.stdin!;
  const output = child.stdout!;
  return await new Promise<{ code: number | null; stdout: string; stderr?: string }>((resolve, reject) => {
    const kill = () => {
      if (group && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch { /* The child may have already exited. */ }
      }
      child.kill("SIGKILL");
    };
    let error: unknown;
    let stdout = "";
    let stderr = "";
    let pending = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > 8 * 1024 * 1024) {
        error = new Error("The Codex output limit was exceeded.");
        kill();
        return;
      }
      stdout += chunk;
      if (!options.onLine) return;
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          options.onLine(line, (value) => input.write(JSON.stringify(value) + "\n"), () => input.end());
        } catch (failure) {
          error = failure;
          kill();
        }
      }
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length + chunk.length > 16 * 1024) {
        error = new Error("The Codex diagnostic output limit was exceeded.");
        kill();
      } else {
        stderr += chunk;
      }
    });
    input.on("error", () => { /* The host can terminate before reading stdin. */ });
    child.once("error", (failure) => { error ??= failure; });
    child.once("close", (code) => {
      signal.removeEventListener("abort", kill);
      if (signal.aborted) reject(signal.reason);
      else if (error) reject(error);
      else resolve({ code, stdout, ...(options.captureStderr ? { stderr } : {}) });
    });
    signal.addEventListener("abort", kill, { once: true });
    if (signal.aborted) kill();
    if (options.onLine) {
      input.write(JSON.stringify({
        id: 1, method: "initialize", params: {
          clientInfo: { name: "axiom-native-adapter", version: "1.0.0" },
          ...(options.experimentalApi && { capabilities: { experimentalApi: true } }),
        },
      }) + "\n");
    } else {
      input.end(options.input);
    }
  });
}

export async function nativeVersion(profile: CodexProfile, signal?: AbortSignal): Promise<string | undefined> {
  const { code, stdout } = await runCodex(profile, ["--version"], signal ? { signal } : {});
  return code === 0 ? /^codex-cli (\S+)\s*$/.exec(stdout)?.[1] : undefined;
}

export async function nativeJson(profile: CodexProfile, args: readonly string[], signal?: AbortSignal): Promise<unknown> {
  const { code, stdout } = await runCodex(profile, args, signal ? { signal } : {});
  if (code !== 0) throw new Error("The native Codex operation failed.");
  return JSON.parse(stdout) as unknown;
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
