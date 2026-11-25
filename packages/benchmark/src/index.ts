import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  backendRequestSchema, backendResultSchema, capabilitySchema, digestSchema,
  evaluationCaseSchema, hostIdentitySchema, policyIdentitySchema, runLimitsSchema,
} from "@axiom/contracts";
import type { EvaluationCase, EvidenceOutcome } from "@axiom/contracts";
import { evidenceSource, fixtureCaptureReason, fixtureText, loadFixture, readFixture, stageFixture } from "./fixtures.js";
import { gradeAttempt, trustedArtifacts } from "./grade.js";
import { abortable, closeRuntime } from "./lifecycle.js";
import { blocked, notRun } from "./model.js";
import type { BenchmarkAttempt, BenchmarkOptions, BenchmarkReport, BenchmarkRuntime } from "./model.js";

export type * from "./model.js";

function aggregate(outcomes: readonly EvidenceOutcome[]): EvidenceOutcome {
  if (outcomes.some(({ status }) => status === "failed")) return { status: "failed", reason: "An executed mandatory result failed." };
  if (outcomes.some(({ status }) => status === "blocked" || status === "not_applicable")) {
    return blocked("A mandatory result is blocked.");
  }
  if (outcomes.some(({ status }) => status === "not_run")) return notRun("A mandatory result did not run.");
  return { status: "passed" };
}

function selectedCases(options: BenchmarkOptions): EvaluationCase[] {
  const cases = options.catalog.map((definition) => evaluationCaseSchema.parse(definition));
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  if (byId.size !== cases.length || new Set(options.caseIds).size !== options.caseIds.length) {
    throw new Error("The catalog and selection require unique case IDs.");
  }
  if (options.caseIds.length === 0) throw new Error("Select at least one benchmark case.");
  return options.caseIds.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`Unknown benchmark case: ${id}.`);
    if (new Set(entry.assertions.map((assertion) => assertion.id)).size !== entry.assertions.length) {
      throw new Error(`Case ${id} contains duplicate assertion IDs.`);
    }
    return entry;
  });
}

function leaveIncomplete(attempt: BenchmarkAttempt, outcome: EvidenceOutcome): void {
  attempt.outcome = outcome;
  for (const assertion of attempt.assertions) {
    if (!assertion.evidenceId) assertion.outcome = notRun("Independent grading did not complete for this attempt.");
  }
}

async function executeAttempt(
  evaluation: EvaluationCase,
  attempt: BenchmarkAttempt,
  options: BenchmarkOptions,
  signal: AbortSignal,
  fixture: () => ReturnType<typeof loadFixture>,
  interruption: () => string,
  stopAll: () => void,
): Promise<void> {
  const open = options.openRuntime;
  if (!open) return leaveIncomplete(attempt, blocked("A runtime isolation provider is unavailable."));
  const scratch = await mkdtemp(join(tmpdir(), "axiom-benchmark-")).catch(() => undefined);
  if (!scratch) return leaveIncomplete(attempt, blocked("The temporary fixture directory could not be created."));
  const workspace = join(scratch, "fixture");
  let removable = true;
  let phase = "The case fixture could not be staged.";
  try {
    const before = await fixture();
    await stageFixture(workspace, before);
    signal.throwIfAborted();

    phase = "The isolated runtime could not be opened.";
    const opening = Promise.resolve().then(() => open(workspace, signal));
    let runtime: BenchmarkRuntime;
    try {
      runtime = await abortable(opening, signal);
    } catch (error) {
      if (signal.aborted) {
        removable = false;
        phase = `${interruption()} The staged workspace was retained pending runtime cleanup.`;
        void opening.then(async (late) => {
          if (await closeRuntime(late)) await rm(scratch, { recursive: true, force: true });
        }, async () => rm(scratch, { recursive: true, force: true })).catch(() => {});
      }
      throw error;
    }

    let returned: unknown;
    try {
      phase = "The backend did not return a valid execution result.";
      signal.throwIfAborted();
      if (runtime.kind !== "fixture" && runtime.kind !== "isolated" && runtime.kind !== "native") throw new Error("Unknown runtime kind.");
      attempt.runtime = runtime.kind;
      const request = backendRequestSchema.parse({
        id: attempt.id, caseId: evaluation.id, prompt: evaluation.prompt, workspace: runtime.workspace,
        host: options.host, policy: options.policy, mode: attempt.mode,
        timeoutMs: options.limits.timeoutMs,
      });
      returned = await abortable(Promise.resolve().then(() => {
        signal.throwIfAborted();
        return runtime.backend.run(request, signal);
      }), signal);
    } finally {
      removable = await closeRuntime(runtime);
      if (!removable) {
        phase = "Runtime teardown could not be confirmed. The staged workspace was retained.";
        stopAll();
      }
    }

    if (!removable) return leaveIncomplete(attempt, blocked(phase));
    const parsed = backendResultSchema.safeParse(returned);
    if (!parsed.success) return leaveIncomplete(attempt, blocked(phase));
    const execution = parsed.data;
    attempt.execution = { ...execution, artifacts: [] };
    if (execution.requestId !== attempt.id || (execution.host && !isDeepStrictEqual(execution.host, options.host))) {
      return leaveIncomplete(attempt, blocked("The observed execution did not match the requested attempt and host settings."));
    }

    phase = "An execution artifact is missing or its identity changed.";
    const artifacts = await trustedArtifacts(execution, options);
    if (!artifacts) return leaveIncomplete(attempt, blocked(phase));
    attempt.execution.artifacts = artifacts;
    if (execution.outcome.status !== "passed") {
      return leaveIncomplete(attempt, execution.outcome.status === "not_applicable"
        ? blocked("The backend cannot waive an execution required by the run.") : execution.outcome);
    }

    signal.throwIfAborted();
    const after = await readFixture(workspace).catch((error: unknown) => {
      phase = fixtureCaptureReason(error);
      throw error;
    });
    phase = "The captured fixture could not be prepared for independent source verification.";
    const scope = await evidenceSource(join(scratch, "verified-source"), after);
    phase = "Independent grading or evidence verification did not complete.";
    await gradeAttempt(evaluation, attempt, {
      before: fixtureText(before), after: fixtureText(after), policy: options.policy, execution: attempt.execution,
    }, scope, options, signal);
    const required = attempt.assertions.filter((assertion) => assertion.required).map(({ outcome }) => outcome);
    if (signal.aborted) required.push(blocked(interruption()));
    attempt.outcome = aggregate(required);
  } catch {
    leaveIncomplete(attempt, blocked(!removable ? phase : signal.aborted ? interruption() : phase));
  } finally {
    if (removable) await rm(scratch, { recursive: true, force: true }).catch(() => {
      if (attempt.outcome.status !== "failed") attempt.outcome = blocked("The disposable fixture could not be removed.");
    });
  }
}

/** Run paired trials with wall-clock, attempt, and concurrency limits. */
export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const limits = runLimitsSchema.parse(options.limits);
  const host = hostIdentitySchema.parse(options.host);
  const policy = policyIdentitySchema.parse(options.policy);
  const grader = { version: options.grader.version, digest: digestSchema.parse(options.grader.digest) };
  if (!grader.version.trim()) throw new Error("A grader version is required.");
  const cases = selectedCases(options);
  if (!Number.isSafeInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error("A positive repetition count is required.");
  }
  // The report retains every scheduled attempt and assertion, including unstarted work.
  const reportEntries = cases.reduce((total, evaluation) => total + 1 + evaluation.assertions.length, 0);
  if (reportEntries * options.repetitions * 2 > 10_000) {
    throw new Error("The benchmark plan is too large to retain its attempt and assertion reports.");
  }
  if (limits.timeoutMs > 2_147_483_647) throw new Error("The duration exceeds the maximum timer interval.");

  const capabilities = new Map(options.capabilities.map((capability) => {
    const parsed = capabilitySchema.parse(capability);
    return [parsed.id, parsed];
  }));
  const runId = randomUUID();
  const plan = cases.flatMap((evaluation) => Array.from({ length: options.repetitions }, (_, index) =>
    (["with_axiom", "without_axiom"] as const).map((mode) => ({ evaluation, mode, repetition: index + 1 })),
  ).flat());
  const attempts: BenchmarkAttempt[] = plan.map(({ evaluation, mode, repetition }, index) => {
    const { id, version, skill, profiles, principleIds } = evaluation;
    return {
      id: `benchmark.${runId}.${index + 1}`, case: { id, version, ...(skill ? { skill } : {}), profiles, principleIds },
      mode, repetition, outcome: notRun("The attempt has not run."),
      assertions: evaluation.assertions.map(({ id: assertionId, required, grader: graderId }) => ({
        id: assertionId, required, grader: graderId, outcome: notRun("Independent grading did not run."),
      })),
    };
  });

  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort("The benchmark timed out."), limits.timeoutMs);
  const interruption = () => options.signal?.aborted ? "The benchmark was cancelled."
    : typeof controller.signal.reason === "string" ? controller.signal.reason : "The benchmark was interrupted.";
  const stopAll = () => controller.abort("The benchmark stopped because runtime teardown could not be confirmed.");
  const fixtureSnapshots = new Map<string, ReturnType<typeof loadFixture>>();
  function snapshot(evaluation: EvaluationCase) {
    let input = fixtureSnapshots.get(evaluation.id);
    if (!input) {
      input = loadFixture(options.fixtureRoot, evaluation);
      fixtureSnapshots.set(evaluation.id, input);
    }
    return input;
  }

  let next = 0;
  let started = 0;
  async function worker() {
    while (next < plan.length) {
      const index = next++;
      const { evaluation } = plan[index]!;
      const attempt = attempts[index]!;
      if (signal.aborted) {
        leaveIncomplete(attempt, notRun(interruption()));
        continue;
      }
      const unavailable = evaluation.requiredCapabilities.flatMap((id) => {
        const capability = capabilities.get(id);
        return capability?.available ? [] : [`${id}: ${capability?.reason ?? "capability unreported"}`];
      });
      if (unavailable.length > 0) {
        leaveIncomplete(attempt, blocked(`Required capabilities unavailable: ${unavailable.join(", ")}.`));
        continue;
      }
      if (evaluation.profiles.some((profile) => !policy.profiles.some((selected) => isDeepStrictEqual(profile, selected)))) {
        leaveIncomplete(attempt, blocked("The requested policy lacks an applicable case profile version."));
        continue;
      }
      if (started >= limits.maxAttempts) {
        leaveIncomplete(attempt, notRun("The benchmark attempt limit was reached."));
        continue;
      }
      started += 1;
      await executeAttempt(evaluation, attempt, { ...options, host, policy, limits }, signal,
        () => snapshot(evaluation), interruption, stopAll);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(limits.maxConcurrency, attempts.length) }, worker));
    return { host, policy, grader, limits, attempts, outcome: aggregate(attempts.map(({ outcome }) => outcome)) };
  } finally {
    clearTimeout(timeout);
  }
}

export function formatBenchmarkReport(report: BenchmarkReport, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(report, null, 2);
  const lines = [`Benchmark ${report.outcome.status} · ${report.host.agent} / ${report.host.model}`];
  for (const attempt of report.attempts) {
    const { execution, outcome } = attempt;
    const runtime = attempt.runtime ? ` · ${attempt.runtime} runtime` : "";
    lines.push(`${attempt.case.id}@${attempt.case.version} ${attempt.mode} #${attempt.repetition}${runtime} — ${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""}`);
    const usage = execution?.usage;
    if (usage?.metering === "reported") {
      const cost = usage.cost ? `${usage.cost.currency} ${usage.cost.amount}` : "cost unknown";
      lines.push(`  Usage ${usage.inputTokens ?? "unknown"} input / ${usage.outputTokens ?? "unknown"} output tokens · ${cost}`);
    } else {
      lines.push(`  Metering unknown${usage ? `: ${usage.reason}` : ""}`);
    }
    for (const assertion of attempt.assertions) {
      lines.push(`  ${assertion.id} (${assertion.required ? "required" : "optional"}) — ${assertion.outcome.status}${assertion.outcome.reason ? `: ${assertion.outcome.reason}` : ""}`);
    }
  }
  return lines.join("\n");
}
