import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark, type BenchmarkAttempt, type BenchmarkGrader, type BenchmarkOptions, type BenchmarkReport, type BenchmarkRuntime } from "@axiom/benchmark";
import { evaluationCaseSchema, type BenchmarkBackend, type EvaluationCase, type EvidenceOutcome, type Usage } from "@axiom/contracts";
import { EvidenceStore } from "@axiom/evidence";
import { gradeCase, type GradingAction } from "@axiom/graders";
import { requireCleanBenchmarkRevision, sha256, type ReviewedBaseline } from "./reviewed-baseline.js";

export const defaultCase = "reuse-summary-formatter";
export const standardQualification = {
  status: "blocked", reason: "The behavioral benchmark alone does not establish installed-host release qualification.",
} as const;

export interface ArchiveOptions {
  repository: string;
  evidenceDirectory?: string;
  baselineRef?: string;
  caseIds?: readonly string[];
  timeoutSeconds: number;
  repetitions: number;
  maxAttempts?: number;
}

export function isSupportedBenchmarkLimits({ timeoutSeconds, repetitions, maxAttempts }: Pick<ArchiveOptions, "timeoutSeconds" | "repetitions" | "maxAttempts">) {
  const limit = (value: number, maximum: number) => Number.isSafeInteger(value) && value > 0 && value <= maximum;
  return limit(timeoutSeconds, 900) && limit(repetitions, 10) && (maxAttempts === undefined || limit(maxAttempts, 20));
}

type Control =
  | { mode: "strict"; provider: "anthropic-messages" | "injected" }
  | { mode: "standard"; provider: "native-account" | "injected"; qualification: EvidenceOutcome };

export type BenchmarkArchive = Control & {
  revision: string;
  sourceFresh: boolean;
  baselineRef: string;
  baselineDigest: string;
  bundleDigest: string;
  metering: Usage;
  outcome: EvidenceOutcome;
  report: BenchmarkReport;
  observations: Record<string, { location: string; digest: string }>;
  results?: ReturnType<typeof summarizeBenchmarkResults>;
};

function armOutcome(results: readonly EvidenceOutcome[]): EvidenceOutcome {
  return results.find(({ status }) => status === "failed")
    ?? results.find(({ status }) => status === "blocked")
    ?? results.find(({ status }) => status === "not_run")
    ?? (results.length && results.every(({ status }) => status === "passed") ? { status: "passed" }
      : { status: "blocked", reason: "A required arm result is missing or inapplicable." });
}

/** Preserve the original paired aggregate and give each arm and the experiment its own result. */
export function summarizeBenchmarkResults({ report, observations, sourceFresh }:
  Pick<BenchmarkArchive, "report" | "observations" | "sourceFresh">) {
  const withAxiom = report.attempts.filter(({ mode }) => mode === "with_axiom");
  const baseline = report.attempts.filter(({ mode }) => mode === "without_axiom");
  const adjudicated = (status: EvidenceOutcome["status"]) => status === "passed" || status === "failed";
  const complete = (attempt: BenchmarkAttempt) => attempt.execution?.outcome.status === "passed"
    && !!observations[attempt.id] && adjudicated(attempt.outcome.status)
    && attempt.assertions.every(({ required, evidenceId, outcome }) => !required ||
      (!!evidenceId && adjudicated(outcome.status)));
  const behavior = (attempts: readonly BenchmarkAttempt[]) => armOutcome(attempts.map((attempt) =>
    sourceFresh && (complete(attempt) || attempt.outcome.status === "not_run") ? attempt.outcome
      : { status: "blocked", reason: "No fresh, complete behavioral grade was recorded for an attempt." }));
  const comparisons = withAxiom.map((attempt) => {
    const { case: { id, version }, repetition } = attempt;
    const paired = baseline.find((candidate) => candidate.case.id === id && candidate.case.version === version
      && candidate.repetition === repetition);
    const outcome: "same" | "improved" | "regressed" | "unavailable" = sourceFresh && paired && complete(attempt) && complete(paired)
      ? attempt.outcome.status === paired.outcome.status ? "same" : attempt.outcome.status === "passed" ? "improved" : "regressed"
      : "unavailable";
    const timings = attempt.execution && paired?.execution &&
      attempt.execution.outcome.status === "passed" && paired.execution.outcome.status === "passed"
      ? { with_axiom: attempt.execution.durationMs, without_axiom: paired.execution.durationMs }
      : undefined;
    return { case: id, version, repetition, outcome, ...(timings && { durationMs: timings }) };
  });
  const execution: EvidenceOutcome = sourceFresh && comparisons.length > 0
    && withAxiom.length === baseline.length && comparisons.every(({ outcome }) => outcome !== "unavailable")
    ? { status: "passed" }
    : { status: "blocked", reason: "At least one planned pair lacks fresh, complete execution and grading evidence." };
  return { execution, behavior: { with_axiom: behavior(withAxiom), without_axiom: behavior(baseline) }, comparisons };
}

export class UnsupportedBenchmarkCase extends Error {}

export async function reviewedGrader(repository: string, baseline: string) {
  const source = join(repository, "evals", "graders");
  const approved = join(baseline, "evals", "graders");
  const executable = fileURLToPath(new URL(".", import.meta.resolve("@axiom/graders")));
  const files = async (path: string) => (await readdir(path)).filter((name) => name.endsWith(".ts")).sort();
  const names = await files(approved);
  if (!names.length || JSON.stringify(names) !== JSON.stringify(await files(source))) throw new Error("Grader source differs.");
  const digests = [];
  for (const name of names) {
    const original = join(approved, name);
    const deployed = join(source, name);
    const compiled = join(executable, name.replace(/\.ts$/, ".js"));
    if (!(await lstat(original)).isFile() || !(await lstat(deployed)).isFile() || !(await lstat(compiled)).isFile()) {
      throw new Error("Invalid grader source or executable.");
    }
    const bytes = await readFile(original);
    if (!bytes.equals(await readFile(deployed))) throw new Error("Grader source differs.");
    digests.push([name, sha256(bytes), sha256(await readFile(compiled))]);
  }
  return sha256(JSON.stringify(digests));
}

export async function reviewedCases(root: string) {
  const parents = ["evals/cases"];
  for (const kind of ["skills", "profiles"]) {
    for (const entry of await readdir(join(root, kind), { withFileTypes: true })) {
      if (entry.isDirectory()) parents.push(`${kind}/${entry.name}/evals`);
    }
  }
  const catalog = [];
  for (const parent of parents) {
    const entries = await readdir(join(root, parent), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const definition = JSON.parse(await readFile(join(root, parent, entry.name), "utf8")) as unknown;
        const parsed = evaluationCaseSchema.safeParse(definition);
        if (parsed.success) catalog.push(parsed.data);
      }
    }
  }
  return catalog;
}

export async function inspectBenchmarkPlan(options: ArchiveOptions, baseline: ReviewedBaseline, revision: string,
  supports: (item: EvaluationCase) => boolean, checkPath?: (path: string) => void) {
  const repository = await realpath(options.repository);
  if (await requireCleanBenchmarkRevision(repository) !== revision) throw new Error("The reviewed revision changed.");
  checkPath?.(repository);
  checkPath?.(await realpath(baseline.directory));
  const grader = await reviewedGrader(repository, baseline.directory);
  const catalog = await reviewedCases(baseline.directory);
  const caseIds = options.caseIds ?? [defaultCase];
  if (!caseIds.length || new Set(caseIds).size !== caseIds.length) throw new UnsupportedBenchmarkCase("Select unique reviewed benchmark cases.");
  const cases = caseIds.map((id) => {
    const item = catalog.find((entry) => entry.id === id);
    if (!item) throw new UnsupportedBenchmarkCase("The requested benchmark case is absent from the reviewed baseline.");
    if (!item.assertions.some(({ required }) => required) || !supports(item)) {
      throw new UnsupportedBenchmarkCase(`The native runner cannot independently evaluate every required assertion for ${id}.`);
    }
    return item;
  });
  const profiles = [...new Set(cases.flatMap((item) => item.profiles.map(({ id }) => id)))];
  return { repository, grader, catalog, cases, caseIds, profiles };
}

export async function prepareBenchmarkArchive(options: ArchiveOptions, baseline: ReviewedBaseline, revision: string,
  baselineRef: string, supports: (item: EvaluationCase) => boolean, checkPath?: (path: string) => void) {
  const plan = await inspectBenchmarkPlan(options, baseline, revision, supports, checkPath);
  const { repository } = plan;
  const destination = resolve(options.evidenceDirectory ?? join(repository, ".axiom", "runs"));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const evidenceParent = await realpath(destination);
  checkPath?.(evidenceParent);
  const evidenceDirectory = await mkdtemp(join(evidenceParent, "benchmark-"));
  return { ...plan, evidenceDirectory, store: new EvidenceStore(evidenceDirectory), options, baseline, baselineRef, revision };
}

type PreparedArchive = Awaited<ReturnType<typeof prepareBenchmarkArchive>>;

export function openNativeRuntime(kind: "isolated" | "native", backend: BenchmarkBackend): NonNullable<BenchmarkOptions["openRuntime"]> {
  return async (workspace): Promise<BenchmarkRuntime> => {
    let pending: ReturnType<BenchmarkBackend["run"]> | undefined;
    return { kind, workspace, backend: { run(request, signal) {
      pending = backend.run(request, signal);
      return pending;
    } }, close: async () => { await pending?.catch(() => {}); } };
  };
}

interface ArchivedRuntime {
  control: Control;
  host: BenchmarkOptions["host"];
  policy: BenchmarkOptions["policy"];
  bundleDigest: string;
  backend: BenchmarkBackend;
  capabilities?: BenchmarkOptions["capabilities"];
  signal: AbortSignal;
  actions?: (...args: Parameters<BenchmarkGrader["grade"]>) => Promise<GradingAction[] | undefined>;
  metering(): Usage;
  assess(report: BenchmarkReport, metering: Usage): EvidenceOutcome;
}

export async function runArchivedBenchmark(archive: PreparedArchive, runtime: ArchivedRuntime) {
  const { options, repository, store, evidenceDirectory, revision, baselineRef, baseline, caseIds } = archive;
  const observations: BenchmarkArchive["observations"] = {};
  const modes = new Map<string, BenchmarkAttempt["mode"]>();
  const report = await runBenchmark({
    host: runtime.host, policy: runtime.policy, fixtureRoot: baseline.directory, catalog: archive.catalog, caseIds, store,
    capabilities: runtime.capabilities ?? [],
    limits: { timeoutMs: options.timeoutSeconds * 1000, maxAttempts: options.maxAttempts ?? caseIds.length * 2 * options.repetitions,
      maxConcurrency: 1 },
    repetitions: options.repetitions, signal: runtime.signal,
    openRuntime: openNativeRuntime(runtime.control.mode === "strict" ? "isolated" : "native", {
      run(request, signal) {
        modes.set(request.id, request.mode);
        return runtime.backend.run(request, signal);
      },
    }),
    grader: {
      version: "1", digest: archive.grader,
      async grade(evaluation, value, signal) {
        const mode = modes.get(value.execution.requestId);
        if (!mode) throw new Error("The grading observation has no matching backend request.");
        const actions = await runtime.actions?.(evaluation, value, signal);
        const grading = { before: value.before, after: value.after, source: value.source, policy: value.policy,
          ...(actions === undefined ? {} : { actions }) };
        const assertions = gradeCase(evaluation, grading);
        const location = `${value.execution.requestId}.grading.json`;
        const bytes = JSON.stringify({ evaluation, mode, ...grading, before: [...value.before], after: [...value.after], assertions }) + "\n";
        await writeFile(join(evidenceDirectory, location), bytes, { flag: "wx", mode: 0o600 });
        observations[value.execution.requestId] = { location, digest: sha256(bytes) };
        return { source: value.source, assertions };
      },
    },
  });
  const metering = runtime.metering();
  const sourceFresh = await requireCleanBenchmarkRevision(repository).then((current) => current === revision, () => false);
  const outcome = sourceFresh ? runtime.assess(report, metering)
    : { status: "blocked" as const, reason: "The reviewed source changed during execution." };
  const result: BenchmarkArchive = { ...runtime.control, revision, sourceFresh, baselineRef, baselineDigest: baseline.digest,
    bundleDigest: runtime.bundleDigest, metering, outcome, report, observations };
  result.results = summarizeBenchmarkResults(result);
  const bytes = JSON.stringify(result, null, 2) + "\n";
  await writeFile(join(evidenceDirectory, "benchmark.json"), bytes, { flag: "wx", mode: 0o600 });
  return { ...result, evidenceDirectory, evidenceDigest: sha256(bytes) };
}
