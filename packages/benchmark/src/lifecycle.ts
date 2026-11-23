import type { BenchmarkRuntime } from "./model.js";

export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Allow a bounded teardown after the execution deadline, so the runtime can revoke the mount. */
export async function closeRuntime(runtime: BenchmarkRuntime): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    await abortable(Promise.resolve().then(() => runtime.close(controller.signal)), controller.signal);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
