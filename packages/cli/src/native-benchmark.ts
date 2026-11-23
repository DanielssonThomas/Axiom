import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildClaudeBundle, createClaudeBackend, supportedVersion } from "@axiom/claude-adapter";
import { runBenchmark } from "@axiom/benchmark";
import { loadBundleWorkspace } from "@axiom/bundles";
import { evaluationCaseSchema, type Evidence, type EvidenceOutcome, type Usage } from "@axiom/contracts";
import { EvidenceStore } from "@axiom/evidence";
import { gradeCase, unavailablePreviewCase, type GradingAction } from "@axiom/graders";
import { assertPrivateBenchmarkPath, launchClaudeSandbox } from "./claude-sandbox.js";
import { anthropicMessages, benchmarkModel, benchmarkTools, inputReservation, openProviderBudget, providerRoute, type MessagesTransport } from "./provider-budget.js";
import { isCommit, prepareReviewedBaseline, requireCleanBenchmarkRevision, sha256, writeReviewedLicense, type ReviewedBaseline } from "./reviewed-baseline.js";

const exec = promisify(execFile);
const blocked = (reason: string): EvidenceOutcome => ({ status: "blocked", reason });
export const defaultCase = "reuse-summary-formatter";
export const defaultBenchmarkLimits = { tokenBudget: 300_000, maxOutputTokens: 2_048, timeoutSeconds: 120, repetitions: 1 };
const host = { agent: "claude", version: supportedVersion, model: benchmarkModel, os: "linux", surface: "cli" };
const observableGraders = new Set(["artifact.existing-formatter", "artifact.command-boundary", "artifact.canonical-model",
  "artifact.preserve-acceptance", "trace.context-discovery"]);
class UnsupportedBenchmarkCase extends Error {}

function isUnavailablePreview(evaluation: { id: string; version: string }) {
  return evaluation.id === unavailablePreviewCase.id && evaluation.version === unavailablePreviewCase.version;
}

function measuredAttempt(before: Usage, after: Usage): Usage {
  if (before.metering === "reported" && after.metering === "reported"
      && before.inputTokens !== undefined && after.inputTokens !== undefined
      && before.outputTokens !== undefined && after.outputTokens !== undefined) {
    return { metering: "reported", inputTokens: after.inputTokens - before.inputTokens, outputTokens: after.outputTokens - before.outputTokens };
  }
  return { metering: "unknown", reason: "The provider did not confirm complete usage for the attempt." };
}

export interface NativeBenchmarkOptions {
  repository: string;
  program?: string;
  evidenceDirectory?: string;
  baselineRef?: string;
  caseIds?: readonly string[];
  allowPaid: boolean;
  model?: string;
  tokenBudget: number;
  maxOutputTokens: number;
  timeoutSeconds: number;
  repetitions: number;
}

export function isSupportedBenchmarkBudget(value: NativeBenchmarkOptions): boolean {
  const { tokenBudget, maxOutputTokens, timeoutSeconds, repetitions } = value;
  return [tokenBudget, maxOutputTokens, timeoutSeconds, repetitions].every((n) => Number.isSafeInteger(n) && n >= 1)
    && tokenBudget >= inputReservation + maxOutputTokens && tokenBudget <= 1_000_000 && maxOutputTokens <= 8_192
    && timeoutSeconds <= 900 && repetitions <= 10;
}

async function claudeProgram(program: string | undefined) {
  if (program !== undefined && !isAbsolute(program)) throw new Error("Use an absolute native executable path.");
  for (const candidate of program ? [program] : (process.env.PATH ?? "").split(":").filter(isAbsolute).map((dir) => join(dir, "claude"))) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return realpath(candidate);
  }
  throw new Error("Pinned Claude Code executable unavailable.");
}

export async function benchmarkReadiness(agent: string, model: string, program?: string, signal?: AbortSignal) {
  if (!process.env.AXIOM_ALLOW_PAID || process.env.AXIOM_ALLOW_PAID !== "true" || agent !== host.agent || model !== host.model
      || process.platform !== host.os) return "runner-unavailable" as const;
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return "credentials-unavailable" as const;
  try {
    await claudeProgram(program);
    await exec("/usr/bin/bwrap", ["--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib",
      "--symlink", "usr/lib64", "/lib64", "--", "/usr/bin/true"], {
      env: {}, timeout: 5_000, ...(signal === undefined ? {} : { signal }),
    });
    return "ready" as const;
  } catch { return "runner-unavailable" as const; }
}

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

async function observedActions(store: EvidenceStore, trace: string | undefined, workspace: string): Promise<GradingAction[] | undefined> {
  if (!trace) return;
  const value = JSON.parse(await readFile(join(store.directory, trace), "utf8")) as { actions?: unknown[] };
  return value.actions?.flatMap((item) => {
    const action = item as { kind?: unknown; path?: unknown };
    if ((action.kind !== "read" && action.kind !== "edit") || typeof action.path !== "string") return [];
    const offset = relative(workspace, resolve(workspace, action.path));
    return offset && !isAbsolute(offset) && offset !== ".." && !offset.startsWith(".." + sep)
      ? [{ kind: action.kind, path: offset.split(sep).join("/") }] : [];
  });
}

export async function runTrustedClaude(
  options: NativeBenchmarkOptions, baseline: ReviewedBaseline, revision: string, baselineRef: string,
  upstream: MessagesTransport, signal?: AbortSignal,
) {
  if (!options.allowPaid || (options.model ?? benchmarkModel) !== benchmarkModel || process.platform !== "linux" ||
      !isSupportedBenchmarkBudget(options)) throw new Error("The isolated benchmark scope requires explicit authorized limits.");
  const repository = await realpath(options.repository);
  if (await requireCleanBenchmarkRevision(repository) !== revision) throw new Error("The trusted revision changed.");
  assertPrivateBenchmarkPath(repository);
  assertPrivateBenchmarkPath(await realpath(baseline.directory));
  const verifiedGrader = await reviewedGrader(repository, baseline.directory);
  const catalog = await reviewedCases(baseline.directory);
  const caseIds = options.caseIds ?? [defaultCase];
  const cases = caseIds.map((id) => {
    const item = catalog.find((entry) => entry.id === id);
    if (!item) throw new UnsupportedBenchmarkCase("The requested benchmark case is absent from the reviewed baseline.");
    if (!item.assertions.some(({ required }) => required) ||
        item.assertions.some(({ required, grader }) => required && !observableGraders.has(grader) &&
          !(isUnavailablePreview(item) && grader === unavailablePreviewCase.grader)) ||
        item.requiredCapabilities.some((id) => id !== "action-trace")) {
      throw new UnsupportedBenchmarkCase(`The native runner cannot independently evaluate every required assertion for ${item.id}.`);
    }
    return item;
  });
  const profiles = [...new Set(cases.flatMap((item) => item.profiles.map(({ id }) => id)))];
  const destination = resolve(options.evidenceDirectory ?? join(repository, ".axiom", "runs"));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const evidenceParent = await realpath(destination);
  assertPrivateBenchmarkPath(evidenceParent);
  const evidenceDirectory = await mkdtemp(join(evidenceParent, "benchmark-"));
  const store = new EvidenceStore(evidenceDirectory);
  const temporary = await mkdtemp("/tmp/axiom-live-");
  const deadline = AbortSignal.timeout(options.timeoutSeconds * 1000);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    await writeReviewedLicense(repository, baseline, baselineRef);
    const { catalog: bundleCatalog, skills } = loadBundleWorkspace(baseline.directory);
    const bundle = await buildClaudeBundle({
      repository: baseline.directory, destination: join(temporary, "bundles"), version: "0.1.0", sourceRevision: baselineRef,
      policyVersion: bundleCatalog.core.version, selectedProfiles: profiles, checks: bundleCatalog.checks, skills,
    });
    const program = await claudeProgram(options.program);
    const provider = await openProviderBudget(join(temporary, "provider.sock"), options.tokenBudget,
      options.maxOutputTokens, upstream, cancellation);
    const backend = createClaudeBackend({
      program, artifacts: evidenceDirectory, bundle, installNative: true,
      tools: [...benchmarkTools],
      environment: { ANTHROPIC_API_KEY: "axiom-loopback" },
      launch: launchClaudeSandbox(provider.socketPath, bundle.directory),
      // Broker limits are authoritative. Claude's internal budget is a secondary estimated stop.
      maxBudgetUsd: 5,
    });
    const workspaces = new Map<string, string>();
    const observedLocalToolSurface = new Set<string>();
    const observations: Record<string, { location: string; digest: string }> = {};
    try {
      const report = await runBenchmark({
        host, policy: bundle.manifest.policy, fixtureRoot: baseline.directory, catalog, caseIds, store,
        capabilities: [{ id: "action-trace", available: true }],
        limits: { timeoutMs: options.timeoutSeconds * 1000, maxAttempts: caseIds.length * 2 * options.repetitions, maxConcurrency: 1 },
        repetitions: options.repetitions, signal: cancellation,
        openRuntime: async (workspace) => {
          let running: ReturnType<typeof backend.run> | undefined;
          return { kind: "isolated", workspace, close: async () => { await running?.catch(() => {}); },
            backend: { async run(request, abort) {
              workspaces.set(request.id, workspace);
              const before = provider.usage();
              const initialSurface = provider.toolSurface();
              running = backend.run(request, abort);
              const result = await running;
              const finalSurface = provider.toolSurface();
              if (finalSurface.submitted > initialSurface.submitted && finalSurface.unfamiliarTools === initialSurface.unfamiliarTools) {
                observedLocalToolSurface.add(request.id);
              }
              return { ...result, usage: measuredAttempt(before, provider.usage()) };
            } },
          };
        },
        grader: {
          version: "1", digest: verifiedGrader,
          async grade(evaluation, value) {
            const trace = value.execution.artifacts.find(({ kind }) => kind === "action-trace");
            const actions = await observedActions(store, trace?.location, workspaces.get(value.execution.requestId)!);
            const id = value.execution.requestId;
            if (actions && isUnavailablePreview(evaluation) && observedLocalToolSurface.has(id)) {
              // The sandbox provides loopback only to the broker and starts no browser preview.
              // The broker independently observed the launch's file/skill-only provider surface.
              const evidence: Evidence = {
                id: `${id}.preview-capability`, taskId: id, criterionIds: [unavailablePreviewCase.criterion],
                source: value.source, policy: value.policy, host: value.execution.host, provenance: "observed",
                startedAt: new Date().toISOString(), durationMs: 0, artifacts: [],
                outcome: blocked("The fixture has no running browser preview."),
              };
              await store.record("acceptance", evidence);
              actions.push({ kind: "check", evidence });
            }
            const grading = { before: value.before, after: value.after, source: value.source, policy: value.policy,
              ...(actions === undefined ? {} : { actions }) };
            const assertions = gradeCase(evaluation, grading);
            const location = `${value.execution.requestId}.grading.json`;
            const bytes = JSON.stringify({ evaluation, ...grading, before: [...value.before], after: [...value.after], assertions }) + "\n";
            await writeFile(join(evidenceDirectory, location), bytes, { flag: "wx", mode: 0o600 });
            observations[value.execution.requestId] = { location, digest: sha256(bytes) };
            return { source: value.source, assertions };
          },
        },
      });
      const metering = provider.usage();
      const sourceFresh = await requireCleanBenchmarkRevision(repository).then((current) => current === revision, () => false);
      const outcome = !sourceFresh ? blocked("The trusted source changed during execution.")
        : report.outcome.status === "failed" ? report.outcome
        : provider.refused || metering.metering !== "reported" || cancellation.aborted
          ? blocked("The benchmark budget, provider usage or cancellation prevented complete execution.")
          : report.outcome;
      const result = { revision, sourceFresh, provider: providerRoute(upstream), baselineRef, baselineDigest: baseline.digest, bundleDigest: bundle.manifest.digest,
        tokenBudget: options.tokenBudget, maxOutputTokens: options.maxOutputTokens, metering, outcome, report, observations };
      const bytes = JSON.stringify(result, null, 2) + "\n";
      await writeFile(join(evidenceDirectory, "benchmark.json"), bytes, { flag: "wx", mode: 0o600 });
      return { ...result, evidenceDirectory, evidenceDigest: sha256(bytes) };
    } finally {
      await provider.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function runNativeBenchmark(agent: string, options: NativeBenchmarkOptions, signal?: AbortSignal) {
  if (agent !== "claude" || (options.model ?? benchmarkModel) !== benchmarkModel || process.platform !== "linux") {
    return { outcome: blocked("The independently budgeted native route currently requires pinned Claude Code on Linux with " + benchmarkModel + ".") };
  }
  if (!options.allowPaid) return { outcome: blocked("Authorize paid execution explicitly with --allow-paid.") };
  if (!isSupportedBenchmarkBudget(options)) return { outcome: blocked("The input reservation, output cap, token budget or time limits are invalid.") };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) return { outcome: blocked("The budgeted provider route requires ANTHROPIC_API_KEY in the trusted operator environment.") };
  let baseline: ReviewedBaseline | undefined;
  try {
    const repository = await realpath(options.repository);
    const revision = await requireCleanBenchmarkRevision(repository);
    const baselineRef = options.baselineRef ?? revision;
    if (!isCommit(baselineRef)) throw new Error("Use a full reviewed commit SHA.");
    baseline = await prepareReviewedBaseline(repository, tmpdir(), revision, { baselineRef });
    const result = await runTrustedClaude(options, baseline, revision, baselineRef, anthropicMessages(key), signal);
    return { outcome: result.outcome, report: result };
  } catch (error) {
    if (error instanceof UnsupportedBenchmarkCase) return { outcome: blocked(error.message) };
    return { outcome: blocked("The reviewed baseline, isolated native runtime, or evidence archive could not be established.") };
  } finally {
    if (baseline) await rm(baseline.directory, { recursive: true, force: true });
  }
}
