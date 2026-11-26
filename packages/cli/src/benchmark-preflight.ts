import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EvidenceOutcome, HostIdentity } from "@axiom/contracts";
import { inspectBenchmarkPlan, isSupportedBenchmarkLimits, standardQualification, UnsupportedBenchmarkCase, type ArchiveOptions } from "./benchmark-archive.js";
import { assertPrivateBenchmarkPath } from "./claude-sandbox.js";
import { assertClaudeSandboxAvailable, strictBenchmarkHost, strictHostUnavailable, supportsStrictBenchmarkCase } from "./native-benchmark.js";
import { nativeProgram } from "./native-program.js";
import { prepareReviewedBaseline, requireCleanBenchmarkRevision, type ReviewedBaseline } from "./reviewed-baseline.js";
import { standardBenchmarkHost, standardHostUnavailable, supportsStandardBenchmarkCase } from "./standard-benchmark.js";

const exec = promisify(execFile);
const blocked = (reason: string): { outcome: EvidenceOutcome } => ({ outcome: { status: "blocked", reason } });

interface PreflightOptions extends ArchiveOptions {
  mode: "standard" | "strict";
  program?: string;
  model?: string;
}

async function probeVersion(host: HostIdentity, home: string, program: string, signal: AbortSignal) {
  const { stdout } = await exec(program, ["--version"], {
    env: { PATH: process.env.PATH, HOME: home }, signal, cwd: home, timeout: 8_000, maxBuffer: 16 * 1024,
  });
  const firstLine = stdout.trim().split(/\r?\n/, 1)[0];
  if (host.agent === "claude") return firstLine === `${host.version} (Claude Code)`;
  if (host.agent === "codex") return firstLine === `codex-cli ${host.version}`;
  const prefix = `Hermes Agent v${host.version}`;
  return firstLine === prefix || firstLine?.startsWith(`${prefix} `);
}

export async function runBenchmarkPreflight(agent: string, options: PreflightOptions, signal: AbortSignal) {
  const strict = options.mode === "strict";
  const host = strict ? strictBenchmarkHost : standardBenchmarkHost(agent, options.model, options.caseIds);
  if (strict && (agent !== strictBenchmarkHost.agent || process.platform !== strictBenchmarkHost.os ||
      (options.model !== undefined && options.model !== strictBenchmarkHost.model))) return blocked(strictHostUnavailable);
  if (!host) return blocked(standardHostUnavailable);
  if (!isSupportedBenchmarkLimits(options)) return blocked("The benchmark limits are invalid.");
  if (!strict && options.model !== undefined && !/^[\w][\w./:-]{0,159}$/.test(options.model)) {
    return blocked("Supply the exact native model identifier.");
  }

  let baseline: ReviewedBaseline | undefined;
  let probeHome: string | undefined;
  try {
    const revision = await requireCleanBenchmarkRevision(options.repository);
    const baselineRef = options.baselineRef ?? revision;
    baseline = await prepareReviewedBaseline(options.repository, tmpdir(), revision, { baselineRef });
    const plan = await inspectBenchmarkPlan(options, baseline, revision,
      strict ? supportsStrictBenchmarkCase : (item) => supportsStandardBenchmarkCase(agent, item, host.surface),
      strict ? assertPrivateBenchmarkPath : undefined);
    const plannedAttempts = 2 * plan.caseIds.length * options.repetitions;
    const limits = { plannedAttempts, maxAttempts: options.maxAttempts ?? plannedAttempts,
      repetitions: options.repetitions, timeoutSeconds: options.timeoutSeconds };
    if (limits.maxAttempts < plannedAttempts) return blocked("The attempt limit cannot cover the requested pairs.");
    const home = await mkdtemp(join(tmpdir(), "axiom-version-"));
    probeHome = home;
    const versionMatches = await nativeProgram(agent, options.program)
      .then((program) => probeVersion(host, home, program, signal)).catch(() => false);
    if (!versionMatches) return blocked(`Select the pinned ${agent} ${host.version} executable with --program.`);
    if (strict && !await assertClaudeSandboxAvailable(signal).then(() => true, () => false)) {
      return blocked("The Linux Bubblewrap sandbox is unavailable.");
    }
    return { outcome: { status: "passed" as const }, report: { host, revision, baselineRef, baselineDigest: baseline.digest,
      graderDigest: plan.grader, caseIds: plan.caseIds, profiles: plan.profiles, limits, ...(strict ? {
        authorization: "--allow-paid", credentials: "ANTHROPIC_API_KEY",
        qualification: { status: "blocked", reason: "Live execution and installed-host evidence are required." },
      } : { authorization: "--allow-native", credentials: "native-account", qualification: standardQualification }),
    } };
  } catch (error) {
    if (error instanceof UnsupportedBenchmarkCase) return blocked(error.message);
    return blocked("Preflight requires a clean checkout, a reviewed baseline, and matching compiled graders.");
  } finally {
    if (probeHome) await rm(probeHome, { recursive: true, force: true });
    if (baseline) await rm(baseline.directory, { recursive: true, force: true });
  }
}
