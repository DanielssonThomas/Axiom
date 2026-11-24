import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildClaudeBundle, createClaudeBackend, supportedVersion as claudeVersion } from "@axiom/claude-adapter";
import { assembleBundles, loadBundleWorkspace, writeBundles } from "@axiom/bundles";
import { buildCodexBundle, createCodexBackend, supportedVersion as codexVersion } from "@axiom/codex-adapter";
import type { BenchmarkBackend, EvidenceOutcome, HostIdentity, PolicyIdentity, Usage } from "@axiom/contracts";
import { createHermesAccountBackend, hermesBundleAdapter, hermesVersion } from "@axiom/hermes-adapter";
import { defaultCase, prepareBenchmarkArchive, runArchivedBenchmark, standardQualification, UnsupportedBenchmarkCase, type ArchiveOptions } from "./benchmark-archive.js";
import { codexDigest } from "./native-install.js";
import { claudeClarificationTopic, readClaudeClarification, supportsClaudeClarification } from "./claude-clarification.js";
import { nativeProgram } from "./native-program.js";
import { isCommit, prepareReviewedBaseline, requireCleanBenchmarkRevision, writeReviewedLicense, type ReviewedBaseline } from "./reviewed-baseline.js";

const hosts = {
  claude: { version: claudeVersion, model: "claude-haiku-4-5-20251001", home: "CLAUDE_CONFIG_DIR", directory: ".claude" },
  codex: { version: codexVersion, model: "gpt-5.4", home: "CODEX_HOME", directory: ".codex" },
  hermes: { version: hermesVersion, model: "gpt-5.4", home: "HERMES_HOME", directory: ".hermes" },
} as const;
type Agent = keyof typeof hosts;

export interface StandardBenchmarkOptions extends ArchiveOptions {
  allowNative: boolean;
  authHome?: string;
  program?: string;
  model?: string;
}

const unknownUsage: Usage = {
  metering: "unknown", reason: "Native counters do not establish aggregate provider or worker usage.",
};
const blocked = (reason: string): { outcome: EvidenceOutcome } => ({ outcome: { status: "blocked", reason } });

interface ArmedBackend {
  backend: BenchmarkBackend;
  policy: PolicyIdentity;
  bundleDigest: string;
}

type ConfiguredArchive = Awaited<ReturnType<typeof prepareBenchmarkArchive>>;
type Configure = (archive: ConfiguredArchive, scratch: string) => Promise<ArmedBackend>;

export async function runStandardArchive(options: StandardBenchmarkOptions, host: HostIdentity,
  provider: "native-account" | "injected", configure: Configure, signal?: AbortSignal) {
  if (!options.allowNative) return blocked("Authorize native model execution explicitly with --allow-native.");
  const limit = (value: number, maximum: number) => Number.isSafeInteger(value) && value > 0 && value <= maximum;
  if (!limit(options.timeoutSeconds, 900) || !limit(options.repetitions, 10) ||
      (options.maxAttempts !== undefined && !limit(options.maxAttempts, 20))) return blocked("The standard time or attempt limits are invalid.");
  const deadline = AbortSignal.timeout(options.timeoutSeconds * 1000);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let baseline: ReviewedBaseline | undefined;
  let scratch: string | undefined;
  try {
    cancellation.throwIfAborted();
    const repository = await realpath(options.repository);
    const revision = await requireCleanBenchmarkRevision(repository);
    const baselineRef = options.baselineRef ?? revision;
    if (!isCommit(baselineRef)) return blocked("Use the full reviewed baseline commit SHA.");
    baseline = await prepareReviewedBaseline(repository, tmpdir(), revision, { baselineRef });
    const claude = host.agent === "claude";
    const archive = await prepareBenchmarkArchive(options, baseline, revision, baselineRef, (item) =>
      (item.id === defaultCase && item.requiredCapabilities.length === 0) || (claude && supportsClaudeClarification(item)));
    await writeReviewedLicense(repository, baseline, baselineRef);
    scratch = await mkdtemp(join(tmpdir(), "axiom-native-account-"));
    cancellation.throwIfAborted();
    const plan = await configure(archive, scratch);
    const workspaces = new Map<string, string>();
    const result = await runArchivedBenchmark(archive, {
      ...plan, host, signal: cancellation,
      ...(claude ? {
        capabilities: [{ id: "action-trace", available: true }] as const,
        backend: { run(request, abort) {
          workspaces.set(request.id, request.workspace);
          return plan.backend.run(request, abort);
        } },
        async actions(evaluation, { execution }) {
          const workspace = workspaces.get(execution.requestId);
          return workspace === undefined ? undefined : readClaudeClarification(archive.store, execution, workspace, evaluation);
        },
      } : {}),
      control: { mode: "standard", provider, hardBudgetEnforcement: "unavailable", qualification: standardQualification },
      metering: () => unknownUsage,
      assess: (report) => report.outcome,
    });
    return { outcome: result.outcome, report: result };
  } catch (error) {
    if (error instanceof UnsupportedBenchmarkCase) return blocked(error.message);
    if (cancellation.aborted) return blocked("The standard benchmark was cancelled or exceeded its time limit.");
    return blocked("The reviewed baseline or native account runtime could not be established. Check the pinned CLI and auth home.");
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    if (baseline) await rm(baseline.directory, { recursive: true, force: true });
  }
}

async function configureNative(agent: Agent, program: string, authHome: string, archive: ConfiguredArchive, scratch: string) {
  const { baseline: { directory: repository }, baselineRef, evidenceDirectory, profiles } = archive;
  const { catalog, skills } = loadBundleWorkspace(repository);
  const version = "0.1.0";
  const common = { version, sourceRevision: baselineRef, policyVersion: catalog.core.version,
    selectedProfiles: profiles, checks: catalog.checks, skills };
  if (agent === "claude") {
    const bundle = await buildClaudeBundle({ ...common, repository, destination: scratch });
    return { policy: bundle.manifest.policy, bundleDigest: bundle.manifest.digest,
      backend: createClaudeBackend({ program, artifacts: evidenceDirectory, bundle, authHome, clarification: claudeClarificationTopic }) };
  }
  if (agent === "codex") {
    const bundle = await buildCodexBundle({ version, source: repository, destination: scratch, catalog, profiles });
    return { policy: bundle.policy, bundleDigest: await codexDigest(bundle.root), backend: createCodexBackend({
      program, artifacts: evidenceDirectory, bundle, authHome,
    }) };
  }
  const [bundle] = writeBundles(scratch, assembleBundles(repository, { ...common, adapters: [hermesBundleAdapter] }));
  if (!bundle) throw new Error("The benchmark Hermes bundle could not be assembled.");
  return { policy: bundle.manifest.policy, bundleDigest: bundle.manifest.digest, backend: createHermesAccountBackend({
    executable: program, archiveDirectory: evidenceDirectory, bundle: bundle.directory, authHome,
  }) };
}

export async function runStandardBenchmark(agent: string, options: StandardBenchmarkOptions, signal?: AbortSignal) {
  if (!options.allowNative) return blocked("Authorize native model execution explicitly with --allow-native.");
  if (!Object.hasOwn(hosts, agent) || process.platform !== "linux") return blocked("Standard account execution currently supports the pinned Linux Claude, Codex, and Hermes CLIs.");
  const name = agent as Agent;
  const host = hosts[name];
  if (options.model !== undefined && !/^[\w][\w./:-]{0,159}$/.test(options.model)) return blocked("Supply the exact native model identifier.");
  const authHome = resolve(options.authHome ?? process.env[host.home] ?? join(homedir(), host.directory));
  return runStandardArchive(options, { agent: name, version: host.version, model: options.model ?? host.model, os: process.platform, surface: "cli" },
    "native-account", async (archive, scratch) => configureNative(name, await nativeProgram(name, options.program), authHome, archive, scratch), signal);
}
