import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

interface Completion {
  code: number | null;
  stdout: string;
  interrupted?: "cancelled" | "timeout" | "output-limit" | "unavailable";
}

interface Launch {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  deadline: number;
  input?: string;
  signal: AbortSignal;
}

const processGroup = process.platform !== "win32";

function stopProcess(child: ChildProcess): void {
  if (processGroup && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch { /* Fall back to the direct child. */ }
  }
  child.kill("SIGKILL");
}

export async function runHermes(options: Launch): Promise<Completion> {
  if (options.signal.aborted) return { code: null, stdout: "", interrupted: "cancelled" };
  const limit = Math.ceil(options.deadline - performance.now());
  if (limit <= 0) return { code: null, stdout: "", interrupted: "timeout" };

  return new Promise((resolve) => {
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd, env: options.env, detached: processGroup, windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"], shell: false,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let interrupted: Completion["interrupted"];

    function stop(reason: NonNullable<Completion["interrupted"]>) {
      if (interrupted) return;
      interrupted = reason;
      stopProcess(child);
    }
    const cancel = () => stop("cancelled");
    const timeout = setTimeout(() => stop("timeout"), limit);
    options.signal.addEventListener("abort", cancel, { once: true });
    if (options.signal.aborted) cancel();

    child.on("error", () => { interrupted ??= "unavailable"; });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) stop("output-limit");
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => { /* Early Hermes exit also closes stdin. */ });
    child.stdin.end(options.input);
    child.on("close", (code) => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", cancel);
      resolve({ code, stdout: Buffer.concat(chunks).toString("utf8"), ...(interrupted && { interrupted }) });
    });
  });
}

type GatewayLaunch =
  | { stop: () => Promise<void>; signal: AbortSignal }
  | { interrupted: "cancelled" | "timeout" | "unavailable" };

/** Own the foreground gateway instead of allowing chat to detach a surviving auto-start owner. */
export async function openHermesGateway(options: Launch, home: string, profile: string, standalone = false): Promise<GatewayLaunch> {
  if (options.signal.aborted) return { interrupted: "cancelled" };
  if (performance.now() >= options.deadline) return { interrupted: "timeout" };
  const child = spawn(options.executable, options.args, {
    cwd: options.cwd, env: options.env, detached: processGroup, windowsHide: true,
    stdio: "ignore", shell: false,
  });
  let closed = false;
  const lifetime = new AbortController();
  child.on("error", () => { closed = true; });
  const finished = new Promise<void>((resolve) => child.once("close", () => {
    closed = true;
    lifetime.abort();
    resolve();
  }));
  const stop = async () => {
    if (!closed) stopProcess(child);
    await finished;
  };
  while (!closed && !options.signal.aborted && performance.now() < options.deadline) {
    try {
      const state = JSON.parse(await readFile(join(home, "gateway_state.json"), "utf8"));
      const servesProfile = Array.isArray(state.served_profiles) && (standalone
        ? state.hermes_home === home && state.served_profiles.length === 0 && Boolean(state.multiplex_standalone_reason)
        : state.served_profiles.includes(profile));
      if (!closed && state.pid === child.pid && state.gateway_state === "running" && servesProfile) {
        return { stop, signal: lifetime.signal };
      }
    } catch { /* Hermes publishes readiness after startup. */ }
    await sleep(25, undefined, { signal: options.signal }).catch(() => {});
  }
  const reason = options.signal.aborted ? "cancelled" : closed ? "unavailable" : "timeout";
  await stop();
  return { interrupted: reason };
}
