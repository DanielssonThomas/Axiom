import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildClaudeBundle, createClaudeBackend, supportedVersion as claudeVersion } from "@axiom/claude-adapter";
import { assembleBundles, loadBundleWorkspace, writeBundles } from "@axiom/bundles";
import { buildCodexBundle, createCodexBackend, supportedVersion as codexVersion } from "@axiom/codex-adapter";
import type { BenchmarkBackend, EvaluationCase, EvidenceOutcome, HostIdentity, PolicyIdentity, Usage } from "@axiom/contracts";
import { createHermesAccountBackend, hermesBundleAdapter, hermesVersion } from "@axiom/hermes-adapter";
import { unavailablePreviewCase } from "@axiom/graders";
import { defaultCase, isSupportedBenchmarkLimits, prepareBenchmarkArchive, runArchivedBenchmark, standardQualification, UnsupportedBenchmarkCase, type ArchiveOptions } from "./benchmark-archive.js";
import { codexDigest } from "./native-install.js";
import { admittedClaudeClarification, readClaudeClarification, supportsClaudeClarification } from "./claude-clarification.js";
import { nativeProgram } from "./native-program.js";
import { nativePreviewActions, supportsNativePreview } from "./preview-observation.js";
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
export const standardHostUnavailable = "Standard account execution currently supports the pinned Linux Claude, Codex, and Hermes CLIs.";

export function standardBenchmarkHost(agent: string, model?: string): HostIdentity | undefined {
  if (!Object.hasOwn(hosts, agent) || process.platform !== "linux") return;
  const host = hosts[agent as Agent];
  return { agent, version: host.version, model: model ?? host.model, os: process.platform, surface: "cli" };
}

export function supportsStandardBenchmarkCase(agent: string, item: EvaluationCase) {
  return (item.id === defaultCase && item.requiredCapabilities.length === 0) || (agent === "claude" && supportsClaudeClarification(item)) ||
    ((agent === "codex" || agent === "hermes") && supportsNativePreview(item));
}

interface ArmedBackend {
  backend: BenchmarkBackend;
  policy: PolicyIdentity;
  bundleDigest: string;
}

type ConfiguredArchive = Awaited<ReturnType<typeof prepareBenchmarkArchive>>;
type Configure = (archive: ConfiguredArchive, scratch: string) => Promise<ArmedBackend>;
type StandardBenchmarkResult = { outcome: EvidenceOutcome; report?: Awaited<ReturnType<typeof runArchivedBenchmark>> };

export async function runStandardArchive(options: StandardBenchmarkOptions, host: HostIdentity,
  provider: "native-account" | "injected", configure: Configure, signal?: AbortSignal): Promise<StandardBenchmarkResult> {
  if (!options.allowNative) return blocked("Authorize native model execution explicitly with --allow-native.");
  if (!isSupportedBenchmarkLimits(options)) return blocked("The standard time or attempt limits are invalid.");
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
      supportsStandardBenchmarkCase(host.agent, item));
    await writeReviewedLicense(repository, baseline, baselineRef);
    scratch = await mkdtemp(join(tmpdir(), "axiom-native-account-"));
    cancellation.throwIfAborted();
    const plan = await configure(archive, scratch);
    const workspaces = new Map<string, string>();
    const preview = archive.cases.some(supportsNativePreview);
    const result = await runArchivedBenchmark(archive, {
      ...plan, host, signal: cancellation,
      ...(claude || preview ? { capabilities: [{ id: "action-trace", available: true }] as const } : {}),
      ...(claude ? {
        backend: { run(request, abort) {
          workspaces.set(request.id, request.workspace);
          return plan.backend.run(request, abort);
        } },
      } : {}),
      async actions(evaluation, value) {
        if (preview && supportsNativePreview(evaluation)) return nativePreviewActions(archive.store, value);
        const workspace = workspaces.get(value.execution.requestId);
        if (workspace !== undefined) return readClaudeClarification(archive.store, value.execution, workspace, evaluation);
      },
      control: { mode: "standard", provider, qualification: standardQualification },
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
  const preview = archive.cases.some(supportsNativePreview) ? { previewCaseId: unavailablePreviewCase.id } : {};
  if (agent === "claude") {
    const bundle = await buildClaudeBundle({ ...common, repository, destination: scratch });
    return { policy: bundle.manifest.policy, bundleDigest: bundle.manifest.digest,
      backend: createClaudeBackend({ program, artifacts: evidenceDirectory, bundle, authHome, clarification: admittedClaudeClarification(archive.cases) }) };
  }
  if (agent === "codex") {
    const bundle = await buildCodexBundle({ version, source: repository, destination: scratch, catalog, profiles });
    return { policy: bundle.policy, bundleDigest: await codexDigest(bundle.root), backend: createCodexBackend({
      program, artifacts: evidenceDirectory, bundle, authHome, ...preview,
    }) };
  }
  const [bundle] = writeBundles(scratch, assembleBundles(repository, { ...common, adapters: [hermesBundleAdapter] }));
  if (!bundle) throw new Error("The benchmark Hermes bundle could not be assembled.");
  return { policy: bundle.manifest.policy, bundleDigest: bundle.manifest.digest, backend: createHermesAccountBackend({
    executable: program, archiveDirectory: evidenceDirectory, bundle: bundle.directory, authHome, ...preview,
  }) };
}

export async function runStandardBenchmark(agent: string, options: StandardBenchmarkOptions, signal?: AbortSignal): Promise<StandardBenchmarkResult> {
  if (!options.allowNative) return blocked("Authorize native model execution explicitly with --allow-native.");
  const selectedHost = standardBenchmarkHost(agent, options.model);
  if (!selectedHost) return blocked(standardHostUnavailable);
  const name = agent as Agent;
  const host = hosts[name];
  if (options.model !== undefined && !/^[\w][\w./:-]{0,159}$/.test(options.model)) return blocked("Supply the exact native model identifier.");
  const authHome = resolve(options.authHome ?? process.env[host.home] ?? join(homedir(), host.directory));
  return runStandardArchive(options, selectedHost,
    "native-account", async (archive, scratch) => configureNative(name, await nativeProgram(name, options.program), authHome, archive, scratch), signal);
}
