import type { ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import spawn from "cross-spawn";
import type { CommandCompletion, CommandInvocation } from "@axiom/evidence";

function killCommand(child: ChildProcess, processGroup: boolean): void {
  if (processGroup && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group may have exited between observing the PID and signaling it.
    }
  }
  child.kill("SIGKILL");
}

export async function runCommand(
  invocation: CommandInvocation, timeoutMs: number, signal?: AbortSignal,
): Promise<CommandCompletion> {
  if (signal?.aborted) return { kind: "interrupted", reason: "cancelled" };
  if (!(await stat(invocation.cwd).then((info) => info.isDirectory(), () => false))) {
    return { kind: "unavailable", reason: "cwd" };
  }
  if (signal?.aborted) return { kind: "interrupted", reason: "cancelled" };

  const processGroup = process.platform !== "win32";
  const child = spawn(invocation.executable, invocation.args, {
    cwd: invocation.cwd, shell: false, stdio: "ignore", detached: processGroup, windowsHide: true,
  });
  return await new Promise<CommandCompletion>((resolve) => {
    let interruption: "timed_out" | "cancelled" | undefined;
    const stop = (reason: NonNullable<typeof interruption>) => {
      interruption ??= reason;
      killCommand(child, processGroup);
    };
    const cancel = () => stop("cancelled");
    const timer = setTimeout(() => stop("timed_out"), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    const finish = (completion: CommandCompletion) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve(completion);
    };
    child.once("close", (exitCode, terminationSignal) => {
      if (interruption || terminationSignal) {
        finish({ kind: "interrupted", reason: interruption ?? "signal", ...(terminationSignal ? { signal: terminationSignal } : {}) });
      } else if (exitCode === null) {
        finish({ kind: "unavailable", reason: "observation" });
      } else {
        finish({ kind: "exited", exitCode });
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (interruption) {
        finish({ kind: "interrupted", reason: interruption });
      } else {
        finish({ kind: "unavailable", reason: error.code === "ENOENT" ? "executable" : "startup" });
      }
    });
  });
}
