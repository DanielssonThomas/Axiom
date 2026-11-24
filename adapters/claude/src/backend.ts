import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { backendRequestSchema, backendResultSchema, type BenchmarkBackend, type EvidenceOutcome, type Usage } from "@axiom/contracts";
import { claudeVersion, hasClaudeSubscription, invokeClaude, subscriptionArguments, type ClaudeLauncher, type ClaudeProfile } from "./process.js";
import { configureClaudeProfile } from "./profile.js";
import { sha256, workerBriefKey } from "./runtime.js";
import { assessClaudeActivation, parseClaudeTrace, supportedClaudeHost } from "./trace.js";
import type { ClaudeBundle } from "./bundle.js";
import { clarificationExchange, type ClarificationTopic } from "./clarification.js";

export interface ClaudeBackendOptions {
  program: string;
  /** Trusted archive outside the disposable workspace. Artifact locations are archive-relative. */
  artifacts: string;
  maxBudgetUsd?: number;
  /** Use native subscription authentication from an existing CLAUDE_CONFIG_DIR. */
  authHome?: string;
  /** HOME for native subscription resources. Defaults to the operator's home. */
  userHome?: string;
  bundle?: ClaudeBundle;
  environment?: Readonly<Record<string, string>>;
  launch?: ClaudeLauncher;
  installNative?: boolean;
  tools?: readonly string[];
  clarification?: (caseId: string) => ClarificationTopic | undefined;
}

export interface ClaudeSessionOptions {
  model: string;
  maxBudgetUsd?: number;
  subscription?: boolean;
  prompt: string;
  signal?: AbortSignal;
  bundle?: ClaudeBundle;
  tools?: readonly string[];
  clarification?: ClarificationTopic;
}

function behind(root: string, path: string): boolean {
  const offset = relative(root, path);
  return !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
}

const subscriptionTools = ["Read", "Glob", "Grep", "Edit", "Write", "Skill"];

function budgetArguments(budget: number | undefined, subscription: boolean): string[] {
  if (subscription && budget === undefined) return [];
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) throw new Error("A positive Claude API budget is required.");
  return ["--max-budget-usd", String(budget)];
}

/** Run one native print session and normalize CLI observations without storing transcript text. */
export async function executeClaudeSession(profile: ClaudeProfile, options: ClaudeSessionOptions) {
  const exchange = options.clarification && clarificationExchange(options.clarification);
  const tools = options.subscription ? subscriptionTools : options.tools ?? (exchange ? subscriptionTools : undefined);
  const enabledTools = tools && (exchange ? [...new Set([...tools, "AskUserQuestion"])] : tools);
  const allowedTools = tools?.filter((tool) => !exchange || tool !== "AskUserQuestion");
  const { code, stdout } = await invokeClaude(profile, [
    ...(options.subscription ? subscriptionArguments : exchange ? ["--restricted"] : []),
    "-p", "--output-format", "stream-json", "--verbose", "--include-hook-events",
    ...(exchange ? ["--input-format", "stream-json", "--permission-prompt-tool", "stdio"] : []),
    "--permission-mode", exchange ? "default" : "dontAsk", "--no-session-persistence",
    ...budgetArguments(options.maxBudgetUsd, !!options.subscription),
    "--model", options.model,
    ...(enabledTools ? ["--tools", enabledTools.join(","), ...(allowedTools?.length ? ["--allowedTools", allowedTools.join(",")] : []),
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'] : []),
    ...(options.bundle ? ["--plugin-dir", options.bundle.plugin] : []),
  ], options.signal, exchange ? { prompt: options.prompt, respond: exchange.respond } : options.prompt);
  const hidden = Object.entries(profile.environment ?? {})
    .filter(([key]) => /(?:token|key|secret|pass|auth|worker.brief)/i.test(key)).map(([, value]) => value);
  return { code, ...parseClaudeTrace(stdout, hidden, profile.environment?.[workerBriefKey], exchange?.questions) };
}

export function createClaudeBackend(options: ClaudeBackendOptions): BenchmarkBackend {
  const { authHome } = options;
  const subscription = authHome !== undefined;
  budgetArguments(options.maxBudgetUsd, subscription);
  if (authHome !== undefined && (!isAbsolute(authHome) || (options.userHome !== undefined && !isAbsolute(options.userHome))
    || options.launch || options.installNative)) {
    throw new Error("Native Claude authentication requires absolute profile roots and a session-only plugin.");
  }
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
      let home: string;
      let userHome: string;
      if (authHome !== undefined) {
        const selected = await realpath(authHome).catch(() => undefined);
        if (!selected || !(await stat(selected)).isDirectory()) {
          return result({ status: "blocked", reason: "The Claude subscription profile is unavailable." });
        }
        if (behind(workspace, selected) || behind(selected, workspace) || behind(archive, selected) || behind(selected, archive)) {
          return result({ status: "blocked", reason: "The Claude subscription profile overlaps the fixture or evidence archive." });
        }
        home = selected;
        userHome = options.userHome ?? homedir();
      } else {
        scope = await mkdtemp(join(tmpdir(), "axiom-claude-profile-"));
        home = join(scope, "claude");
        userHome = join(scope, "home");
        await Promise.all([mkdir(home), mkdir(userHome)]);
      }
      const profile: ClaudeProfile = {
        program: options.program, workspace, home, userHome,
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.launch ? { launch: options.launch } : {}),
      };
      if (await claudeVersion(profile, signal) !== request.host.version) {
        return result({ status: "blocked", reason: "The installed Claude CLI version differs from the request." });
      }
      if (subscription && !await hasClaudeSubscription(profile, signal)) {
        return result({ status: "blocked", reason: "Sign in to the selected Claude Code profile with a native claude.ai subscription." });
      }
      if (bundle && options.installNative) await configureClaudeProfile(profile, "user", "install", bundle, signal);
      const clarification = options.clarification?.(request.caseId);
      const trace = await executeClaudeSession(profile, {
        model: request.host.model, prompt: request.prompt, signal, subscription,
        ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
        ...(bundle && !options.installNative ? { bundle } : {}),
        ...(options.tools ? { tools: options.tools } : {}),
        ...(clarification ? { clarification } : {}),
      });
      usage = subscription && trace.usage.metering === "reported"
        ? { metering: "reported", inputTokens: trace.usage.inputTokens, outputTokens: trace.usage.outputTokens } : trace.usage;
      if (trace.observation.observedModel !== request.host.model || trace.observation.observedVersion !== request.host.version) {
        return result({ status: "blocked", reason: "The requested Claude model and version were not independently observed." });
      }
      host = { ...request.host, model: trace.observation.observedModel, version: trace.observation.observedVersion };
      await mkdir(archive, { recursive: true, mode: 0o700 });
      const storage = await realpath(archive);
      if (behind(workspace, storage)) return result({ status: "blocked", reason: "The Claude trace archive resolves inside the disposable workspace." });
      if (subscription && (behind(home, storage) || behind(storage, home))) {
        return result({ status: "blocked", reason: "The Claude trace archive resolves into the subscription profile scope." });
      }
      const location = `${request.id}.${randomUUID()}.json`;
      const serialized = JSON.stringify({ actions: trace.actions, activation: trace.observation }) + "\n";
      await writeFile(join(storage, location), serialized, { flag: "wx", mode: 0o600 });
      artifacts.push({ kind: "action-trace", location, digest: sha256(serialized) });
      if (trace.code !== 0) return result({ status: "blocked", reason: "The native Claude CLI exited before completing the attempt." });
      if (bundle) {
        const activation = assessClaudeActivation(bundle, host, trace.observation);
        if (activation.outcome.status !== "passed") return result(activation.outcome);
      } else if (trace.observation.discovered || trace.observation.policyDigests.length > 0
        || trace.observation.skills.some((name) => name.startsWith("axiom:"))) {
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
