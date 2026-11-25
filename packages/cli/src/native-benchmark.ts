import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { buildClaudeBundle, createClaudeBackend, supportedVersion } from "@axiom/claude-adapter";
import { loadBundleWorkspace } from "@axiom/bundles";
import type { EvaluationCase, EvidenceOutcome } from "@axiom/contracts";
import { EvidenceStore } from "@axiom/evidence";
import { unavailablePreviewCase, type GradingAction } from "@axiom/graders";
import { assertPrivateBenchmarkPath, launchClaudeSandbox } from "./claude-sandbox.js";
import { anthropicMessages, benchmarkModel, benchmarkTools, openClaudeProvider, providerRoute, type MessagesTransport } from "./claude-provider.js";
import { isCommit, prepareReviewedBaseline, requireCleanBenchmarkRevision, writeReviewedLicense, type ReviewedBaseline } from "./reviewed-baseline.js";

import { isSupportedBenchmarkLimits, prepareBenchmarkArchive, runArchivedBenchmark, UnsupportedBenchmarkCase, type ArchiveOptions } from "./benchmark-archive.js";
import { nativeProgram } from "./native-program.js";
import { admittedClaudeClarification, readClaudeClarification, supportsClaudeClarification } from "./claude-clarification.js";
import { isUnavailablePreview, recordUnavailablePreview } from "./preview-observation.js";

const exec = promisify(execFile);
const blocked = (reason: string): EvidenceOutcome => ({ status: "blocked", reason });
export { defaultCase } from "./benchmark-archive.js";
export const defaultBenchmarkLimits = { timeoutSeconds: 120, repetitions: 1 };
export const strictBenchmarkHost = { agent: "claude", version: supportedVersion, model: benchmarkModel, os: "linux", surface: "cli" };
export const strictHostUnavailable = "The isolated native route currently requires pinned Claude Code on Linux with " + benchmarkModel + ".";
const observableGraders = new Set(["artifact.existing-formatter", "artifact.command-boundary", "artifact.canonical-model",
  "artifact.preserve-acceptance", "trace.context-discovery"]);


export function supportsStrictBenchmarkCase(item: EvaluationCase) {
  return supportsClaudeClarification(item) || (item.assertions.every(({ required, grader }) => !required || observableGraders.has(grader) ||
    (isUnavailablePreview(item) && grader === unavailablePreviewCase.grader)) &&
    item.requiredCapabilities.every((id) => id === "action-trace"));
}

export interface NativeBenchmarkOptions extends ArchiveOptions {
  program?: string;
  allowPaid: boolean;
  model?: string;
}

export async function assertClaudeSandboxAvailable(signal?: AbortSignal) {
  await exec("/usr/bin/bwrap", ["--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64", "--", "/usr/bin/true"], {
    env: {}, timeout: 5_000, ...(signal === undefined ? {} : { signal }),
  });
}

export async function benchmarkReadiness(agent: string, model: string, program?: string, signal?: AbortSignal) {
  const { agent: supportedAgent, model: supportedModel, os } = strictBenchmarkHost;
  if (process.env.AXIOM_ALLOW_PAID !== "true" || agent !== supportedAgent || model !== supportedModel || process.platform !== os) {
    return "runner-unavailable" as const;
  }
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return "credentials-unavailable" as const;
  try {
    await nativeProgram("claude", program);
    await assertClaudeSandboxAvailable(signal);
    return "ready" as const;
  } catch { return "runner-unavailable" as const; }
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
      !isSupportedBenchmarkLimits(options)) throw new Error("The isolated benchmark requires authorization and valid time and attempt limits.");
  const archive = await prepareBenchmarkArchive(options, baseline, revision, baselineRef, supportsStrictBenchmarkCase, assertPrivateBenchmarkPath);
  const { repository, evidenceDirectory, store, profiles } = archive;
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
    const program = await nativeProgram("claude", options.program);
    const provider = await openClaudeProvider(join(temporary, "provider.sock"), upstream, cancellation);
    const backend = createClaudeBackend({
      program, artifacts: evidenceDirectory, bundle, installNative: true,
      tools: [...benchmarkTools], clarification: admittedClaudeClarification(archive.cases),
      environment: { ANTHROPIC_API_KEY: "axiom-loopback" },
      launch: launchClaudeSandbox(provider.socketPath, bundle.directory),
    });
    const workspaces = new Map<string, string>();
    const observedLocalToolSurface = new Set<string>();
    try {
      return await runArchivedBenchmark(archive, {
        control: { mode: "strict", provider: providerRoute(upstream) },
        host: strictBenchmarkHost, policy: bundle.manifest.policy, bundleDigest: bundle.manifest.digest,
        capabilities: [{ id: "action-trace", available: true }], signal: cancellation,
        backend: { async run(request, abort) {
          workspaces.set(request.id, request.workspace);
          const before = provider.snapshot();
          const initialSurface = provider.toolSurface();
          const result = await backend.run(request, abort);
          const finalSurface = provider.toolSurface();
          if (finalSurface.submitted > initialSurface.submitted && finalSurface.unfamiliarTools === initialSurface.unfamiliarTools) {
            observedLocalToolSurface.add(request.id);
          }
          return { ...result, usage: provider.usage(before) };
        } },
        async actions(evaluation, value) {
          const { execution } = value;
          const id = execution.requestId;
          const workspace = workspaces.get(id);
          if (workspace === undefined) return;
          if (supportsClaudeClarification(evaluation)) return readClaudeClarification(store, execution, workspace, evaluation);
          const trace = execution.artifacts.find(({ kind }) => kind === "action-trace");
          const actions = await observedActions(store, trace?.location, workspace);
          if (actions && isUnavailablePreview(evaluation) && observedLocalToolSurface.has(id)) {
            // The sandbox provides loopback only to the broker and starts no browser preview.
            // The broker independently observed the launch's file/skill-only provider surface.
            actions.push(await recordUnavailablePreview(store, value));
          }
          return actions;
        },
        metering: provider.usage,
        assess(report) {
          if (report.outcome.status === "failed") return report.outcome;
          if (cancellation.aborted) return blocked("The isolated benchmark was cancelled or exceeded its time limit.");
          return report.outcome;
        },
      });
    } finally {
      await provider.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function runNativeBenchmark(agent: string, options: NativeBenchmarkOptions, signal?: AbortSignal) {
  if (agent !== "claude" || (options.model ?? benchmarkModel) !== benchmarkModel || process.platform !== "linux") {
    return { outcome: blocked(strictHostUnavailable) };
  }
  if (!options.allowPaid) return { outcome: blocked("Authorize paid execution explicitly with --allow-paid.") };
  if (!isSupportedBenchmarkLimits(options)) return { outcome: blocked("The isolated time or attempt limits are invalid.") };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) return { outcome: blocked("The isolated provider route requires ANTHROPIC_API_KEY in the trusted operator environment.") };
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
