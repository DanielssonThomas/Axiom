import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, stat, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { digestSchema, evidenceOutcomeSchema, usageSchema } from "@axiom/contracts";
import type { EvidenceOutcome, ResultStatus, Usage } from "@axiom/contracts";

interface DispatchIdentity {
  event?: string | undefined;
  ref?: string | undefined;
  actor?: string | undefined;
  triggeringActor?: string | undefined;
  owner?: string | undefined;
}

export function authorizeDispatch(identity: DispatchIdentity): boolean {
  return identity.event === "workflow_dispatch" && identity.ref === "refs/heads/main" && Boolean(identity.owner)
    && identity.actor === identity.owner && identity.triggeringActor === identity.owner;
}

export interface LiveInputs {
  host: "claude" | "codex" | "hermes";
  model: string;
  os: "linux" | "macos" | "windows";
  baselineRef: string;
  baselineDigest: string;
  attempts: number;
  timeoutMinutes: number;
  tokenBudget: number;
}

function positiveInteger(input: string | undefined, max: number): number {
  if (!input || !/^[1-9]\d*$/.test(input) || Number(input) > max) throw new Error("The live run limits are invalid.");
  return Number(input);
}

function isCommit(input: string | undefined): input is string {
  return Boolean(input && /^[a-f0-9]{40}$/.test(input));
}

export function parseLiveInputs(environment: NodeJS.ProcessEnv): LiveInputs {
  const { AXIOM_HOST: host, AXIOM_MODEL: model, AXIOM_OS: os, AXIOM_BASELINE_REF: baselineRef } = environment;
  if (host !== "claude" && host !== "codex" && host !== "hermes") throw new Error("An installed host is required.");
  if (os !== "linux" && os !== "macos" && os !== "windows") throw new Error("An operating system is required.");
  if (!model || !/^[a-z0-9][a-z0-9/._:-]{0,127}$/i.test(model)) throw new Error("An exact model identifier is required.");
  if (!isCommit(baselineRef)) throw new Error("An immutable reviewed baseline commit is required.");
  return {
    host, model, os, baselineRef, baselineDigest: digestSchema.parse(environment.AXIOM_BASELINE_DIGEST),
    attempts: positiveInteger(environment.AXIOM_ATTEMPTS, 25),
    timeoutMinutes: positiveInteger(environment.AXIOM_TIMEOUT_MINUTES, 15),
    tokenBudget: positiveInteger(environment.AXIOM_TOKEN_BUDGET, 1_000_000),
  };
}

const exec = promisify(execFile);

interface ReviewedBaseline {
  directory: string;
  digest: string;
}

/** Export the reviewed Git tree, whose archived bytes are the inputs given to the verifier. */
export async function prepareReviewedBaseline(
  checkout: string, temporary: string, revision: string, input: LiveInputs,
): Promise<ReviewedBaseline> {
  if (!isCommit(revision) || !isCommit(input.baselineRef)) throw new Error("A reviewed revision is required.");
  await exec("git", ["merge-base", "--is-ancestor", input.baselineRef, revision], { cwd: checkout }).catch(() => {
    throw new Error("The baseline is outside the reviewed revision's history.");
  });
  const { stdout } = await exec("git", ["archive", "--format=tar", input.baselineRef, "--", "core", "evals", "profiles", "skills"], {
    cwd: checkout,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  const digest = `sha256:${createHash("sha256").update(stdout).digest("hex")}`;
  if (digest !== input.baselineDigest) throw new Error("The reviewed baseline digest does not match.");
  const directory = await mkdtemp(join(temporary, "axiom-reviewed-"));
  const archive = join(directory, "baseline.tar");
  try {
    await writeFile(archive, stdout, { flag: "wx", mode: 0o600 });
    await exec("tar", ["-xf", archive, "-C", directory]);
    await rm(archive);
    return { directory, digest };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

interface LiveTrial {
  host: LiveInputs["host"];
  model: string;
  os: LiveInputs["os"];
  attempt: number;
  tokenLimit: number;
  baseline: ReviewedBaseline;
}

/** The trusted installed-host runner enforces tokenLimit before provider calls, isolates agent access
 * from the verifier baseline, terminates on abort, and returns independently observed installed-host evidence. */
export interface TrustedLiveRunner {
  readiness(input: Pick<LiveTrial, "host" | "model" | "os">, signal: AbortSignal):
    Promise<"ready" | "runner-unavailable" | "credentials-unavailable">;
  run(trial: LiveTrial, signal: AbortSignal): Promise<unknown>;
}

interface LiveAttempt {
  attempt: number;
  outcome: EvidenceOutcome;
  inputTokens?: number;
  outputTokens?: number;
  evidenceDigest?: string;
  observedStatus?: ResultStatus;
}

const blocked = (reason: string): EvidenceOutcome => ({ status: "blocked", reason });
const notRun = (reason: string): EvidenceOutcome => ({ status: "not_run", reason });

async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let interrupt = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    interrupt = () => reject(signal.reason);
    signal.addEventListener("abort", interrupt, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }), cancelled]);
  } finally {
    signal.removeEventListener("abort", interrupt);
  }
}

function observedResult(raw: unknown, input: LiveInputs):
  { outcome: EvidenceOutcome; evidenceDigest?: string; observedStatus?: ResultStatus; metering?: Usage } {
  if (typeof raw !== "object" || raw === null) return { outcome: blocked("No installed-host evidence was returned.") };
  const value = raw as Record<string, unknown>;
  if (value.host !== input.host || value.model !== input.model || value.os !== input.os) {
    return { outcome: blocked("The observed host, model, or OS does not match the dispatch.") };
  }
  const parsed = evidenceOutcomeSchema.safeParse(value.outcome);
  const evidence = digestSchema.safeParse(value.evidenceDigest);
  if (!parsed.success || !evidence.success) return { outcome: blocked("Required installed-host evidence was missing or invalid.") };
  const metering = usageSchema.safeParse(value.metering);
  const { status } = parsed.data;
  const outcome: EvidenceOutcome = status === "passed" ? { status }
    : status === "not_applicable" ? blocked("A required live check cannot be waived.")
    : { status, reason: "The installed-host check did not meet the requirement." };
  return { outcome, evidenceDigest: evidence.data, observedStatus: status, ...(metering.success ? { metering: metering.data } : {}) };
}

export async function runLiveValidation(
  input: LiveInputs, baseline: ReviewedBaseline, runner?: TrustedLiveRunner, cancellation?: AbortSignal,
) {
  positiveInteger(String(input.attempts), 25);
  positiveInteger(String(input.timeoutMinutes), 15);
  positiveInteger(String(input.tokenBudget), 1_000_000);
  const { host, model, os } = input;
  const attempts: LiveAttempt[] = Array.from({ length: input.attempts }, (_, index) => ({
    attempt: index + 1, outcome: notRun("The attempt has not started."),
  }));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMinutes * 60_000);
  const signal = cancellation ? AbortSignal.any([controller.signal, cancellation]) : controller.signal;
  const interruption = () => cancellation?.aborted ? "The live run was cancelled." : "The live run timed out.";
  let remaining = input.tokenBudget;
  let unavailable: string | undefined;
  try {
    if (baseline.digest !== input.baselineDigest) unavailable = "The reviewed baseline identity does not match.";
    else if (!runner) unavailable = "The installed-host runner is unavailable.";
    else {
      const readiness = await bounded(() => runner.readiness({ host, model, os }, signal), signal).catch(() => "runner-unavailable");
      if (readiness !== "ready") unavailable = signal.aborted ? interruption()
        : readiness === "credentials-unavailable" ? "The installed host credentials are unavailable."
        : "The installed-host runner is unavailable.";
    }

    for (const attempt of attempts) {
      if (!runner || unavailable) {
        attempt.outcome = notRun(unavailable ?? "The installed-host runner is unavailable.");
        continue;
      }
      if (signal.aborted || remaining === 0) {
        attempt.outcome = notRun(signal.aborted ? interruption() : "The token budget is exhausted.");
        continue;
      }
      try {
        const value = await bounded(() => runner.run({
          host, model, os, attempt: attempt.attempt, tokenLimit: remaining, baseline,
        }, signal), signal);
        const observed = observedResult(value, input);
        attempt.outcome = observed.outcome;
        if (observed.evidenceDigest) attempt.evidenceDigest = observed.evidenceDigest;
        if (observed.observedStatus) attempt.observedStatus = observed.observedStatus;
        const usage = observed.metering;
        if (usage?.metering !== "reported" || usage.inputTokens === undefined || usage.outputTokens === undefined) {
          if (attempt.outcome.status === "passed") attempt.outcome = blocked("Actual token usage was unavailable.");
          unavailable = "Further attempts require complete token metering.";
          continue;
        }
        attempt.inputTokens = usage.inputTokens;
        attempt.outputTokens = usage.outputTokens;
        const spent = usage.inputTokens + usage.outputTokens;
        if (spent > remaining) {
          attempt.outcome = { status: "failed", reason: "The installed host exceeded the allocated token budget." };
          remaining = 0;
        } else {
          remaining -= spent;
        }
      } catch {
        attempt.outcome = blocked(signal.aborted ? interruption() : "The installed-host runner did not return observable results.");
        unavailable = "Further attempts stopped after interrupted or unobserved execution.";
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  const outcome: EvidenceOutcome = attempts.some((attempt) => attempt.outcome.status === "failed")
    ? { status: "failed", reason: "A required live check failed." }
    : !unavailable && attempts.every((attempt) => attempt.outcome.status === "passed")
      ? { status: "passed" }
      : blocked(unavailable ?? "Required installed-host evidence is incomplete.");
  return { host, model, os, baselineRef: input.baselineRef, baselineDigest: baseline.digest, tokenBudget: input.tokenBudget,
    timeoutMinutes: input.timeoutMinutes, attempts, outcome };
}

async function main(): Promise<void> {
  const env = process.env;
  const temporary = env.RUNNER_TEMP;
  if (!temporary) throw new Error("Runner temporary storage is unavailable.");
  let baseline: ReviewedBaseline | undefined;
  let report: Awaited<ReturnType<typeof runLiveValidation>> | { outcome: EvidenceOutcome };
  try {
    if (!authorizeDispatch({
      event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, actor: env.GITHUB_ACTOR,
      triggeringActor: env.AXIOM_TRIGGERING_ACTOR, owner: env.GITHUB_REPOSITORY_OWNER,
    })) throw new Error("Dispatch is not authorized.");
    const input = parseLiveInputs(env);
    const platform = { linux: "linux", macos: "darwin", windows: "win32" } as const;
    if (platform[input.os] !== process.platform) throw new Error("The runner does not match the selected OS.");
    baseline = await prepareReviewedBaseline(process.cwd(), temporary, env.GITHUB_SHA ?? "", input);
    const runnerUrl = new URL("../integration/hosts/ci-runner.mjs", import.meta.url);
    // Presence is checked without loading any code from staged agent workspaces or grader archives.
    const exists = await stat(runnerUrl).then((info) => info.isFile(), () => false);
    const runner = exists ? (await import(runnerUrl.href)).default as TrustedLiveRunner : undefined;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      report = await runLiveValidation(input, baseline, runner, abort.signal);
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  } catch {
    report = { outcome: blocked("The dispatch, reviewed baseline, or installed-host runner could not be verified.") };
  } finally {
    if (baseline) await rm(baseline.directory, { recursive: true, force: true }).catch(() => {});
  }
  const revision = isCommit(env.GITHUB_SHA) ? env.GITHUB_SHA : undefined;
  await writeFile(join(temporary, "axiom-live-summary.json"), `${JSON.stringify({ revision, ...report }, null, 2)}\n`, { mode: 0o600 });
  if (report.outcome.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(resolve(process.argv[1])))) {
  await main();
}
