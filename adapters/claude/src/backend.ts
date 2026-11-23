import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { backendRequestSchema, backendResultSchema, type BenchmarkBackend, type EvidenceOutcome, type Usage } from "@axiom/contracts";
import { claudeVersion, invokeClaude, type ClaudeProfile } from "./process.js";
import { sha256, workerBriefKey } from "./runtime.js";
import { assessClaudeActivation, parseClaudeTrace, supportedClaudeHost } from "./trace.js";
import type { ClaudeBundle } from "./bundle.js";

export interface ClaudeBackendOptions {
  program: string;
  /** Trusted archive outside the disposable workspace. Artifact locations are archive-relative. */
  artifacts: string;
  maxBudgetUsd: number;
  bundle?: ClaudeBundle;
  environment?: Readonly<Record<string, string>>;
}

export interface ClaudeSessionOptions {
  model: string;
  maxBudgetUsd: number;
  prompt: string;
  signal?: AbortSignal;
  bundle?: ClaudeBundle;
}

function behind(root: string, path: string): boolean {
  const offset = relative(root, path);
  return !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
}

/** Run one native print session and normalize CLI observations without storing transcript text. */
export async function executeClaudeSession(profile: ClaudeProfile, options: ClaudeSessionOptions) {
  if (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd <= 0) throw new Error("A positive Claude API budget is required.");
  const { code, stdout } = await invokeClaude(profile, [
    "-p", "--output-format", "stream-json", "--verbose", "--include-hook-events",
    "--permission-mode", "dontAsk", "--no-session-persistence", "--max-budget-usd", String(options.maxBudgetUsd),
    "--model", options.model,
    ...(options.bundle ? ["--plugin-dir", options.bundle.plugin] : []),
  ], options.signal, options.prompt);
  const hidden = Object.entries(profile.environment ?? {})
    .filter(([key]) => /(?:token|key|secret|pass|auth|worker.brief)/i.test(key)).map(([, value]) => value);
  return { code, ...parseClaudeTrace(stdout, hidden, profile.environment?.[workerBriefKey]) };
}

export function createClaudeBackend(options: ClaudeBackendOptions): BenchmarkBackend {
  if (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd <= 0) throw new Error("A positive Claude API budget is required.");
  return { async run(raw, cancelled) {
    const request = backendRequestSchema.parse(raw);
    const clock = performance.now();
    const timeout = AbortSignal.timeout(Math.min(request.timeoutMs, 2_147_483_647));
    const signal = AbortSignal.any([cancelled, timeout]);
    let scope: string | undefined;
    let host: typeof request.host | undefined;
    let usage: Usage = { metering: "unknown", reason: "Claude Code did not report validated usage." };
    const artifacts: { kind: string; location: string; digest: string }[] = [];
    const result = (outcome: EvidenceOutcome) => backendResultSchema.parse({
      requestId: request.id, outcome, durationMs: performance.now() - clock, usage, artifacts,
      ...(host ? { host } : {}),
    });
    if (cancelled.aborted) return result({ status: "not_run", reason: "The Claude attempt was cancelled before launch." });
    if (!supportedClaudeHost(request.host) || request.host.os !== process.platform) {
      return result({ status: "blocked", reason: "The requested Claude surface, platform, or version is unsupported." });
    }
    const bundle = request.mode === "with_axiom" ? options.bundle : undefined;
    if (request.mode === "with_axiom" && (!bundle || !isDeepStrictEqual(bundle.manifest.policy, request.policy))) {
      return result({ status: "blocked", reason: "The requested policy does not match an available Claude bundle." });
    }
    try {
      const workspace = await realpath(request.workspace);
      const archive = resolve(options.artifacts);
      if (behind(workspace, archive)) return result({ status: "blocked", reason: "The Claude trace archive overlaps the disposable workspace." });
      scope = await mkdtemp(join(tmpdir(), "axiom-claude-profile-"));
      const profile: ClaudeProfile = {
        program: options.program, workspace, home: join(scope, "claude"), userHome: join(scope, "home"),
        ...(options.environment ? { environment: options.environment } : {}),
      };
      await Promise.all([mkdir(profile.home), mkdir(profile.userHome)]);
      if (await claudeVersion(profile, signal) !== request.host.version) {
        return result({ status: "blocked", reason: "The installed Claude CLI version differs from the request." });
      }
      const trace = await executeClaudeSession(profile, {
        model: request.host.model, maxBudgetUsd: options.maxBudgetUsd, prompt: request.prompt, signal,
        ...(bundle ? { bundle } : {}),
      });
      usage = trace.usage;
      if (trace.observation.observedModel !== request.host.model || trace.observation.observedVersion !== request.host.version) {
        return result({ status: "blocked", reason: "The requested Claude model and version were not independently observed." });
      }
      host = { ...request.host, model: trace.observation.observedModel, version: trace.observation.observedVersion };
      await mkdir(archive, { recursive: true, mode: 0o700 });
      const storage = await realpath(archive);
      if (behind(workspace, storage)) return result({ status: "blocked", reason: "The Claude trace archive resolves inside the disposable workspace." });
      const location = `${request.id}.${randomUUID()}.json`;
      const serialized = JSON.stringify({ actions: trace.actions, activation: trace.observation }) + "\n";
      await writeFile(join(storage, location), serialized, { flag: "wx", mode: 0o600 });
      artifacts.push({ kind: "action-trace", location, digest: sha256(serialized) });
      if (trace.code !== 0) return result({ status: "blocked", reason: "The native Claude CLI exited before completing the attempt." });
      if (bundle) {
        const activation = assessClaudeActivation(bundle, host, trace.observation);
        if (activation.outcome.status !== "passed") return result(activation.outcome);
      } else if (trace.observation.discovered || trace.observation.policyDigests.length > 0) {
        return result({ status: "blocked", reason: "Axiom was unexpectedly active in the baseline Claude session." });
      }
      return result(trace.outcome);
    } catch {
      if (cancelled.aborted) return result({ status: "blocked", reason: "The Claude attempt was cancelled." });
      if (timeout.aborted) return result({ status: "blocked", reason: "The Claude attempt exceeded its time limit." });
      return result({ status: "blocked", reason: "The Claude attempt could not be staged, executed, or recorded." });
    } finally {
      if (scope) await rm(scope, { recursive: true, force: true });
    }
  } };
}
