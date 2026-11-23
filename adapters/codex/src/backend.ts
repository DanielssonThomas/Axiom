import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { backendRequestSchema, backendResultSchema, usageSchema, type BenchmarkBackend, type EvidenceOutcome, type Usage } from "@axiom/contracts";
import { supportedCodexHost } from "./activation.js";
import { digest, type CodexBundle } from "./bundle.js";
import { configureCodexProfile, observeCodexProfile } from "./profile.js";
import { array, nativeVersion, object, runCodex, type CodexProfile } from "./process.js";

type NormalizedAction =
  | { kind: "command"; command: string; exitCode?: number }
  | { kind: "file-change"; path: string; change: "add" | "delete" | "update" };

export interface CodexTrace {
  outcome: EvidenceOutcome;
  actions: NormalizedAction[];
  usage: Usage;
}

export function parseCodexTrace(output: string, sensitiveValues: readonly string[] = []): CodexTrace {
  const actions: NormalizedAction[] = [];
  let usage: Usage = { metering: "unknown", reason: "Codex did not report validated token usage." };
  let outcome: EvidenceOutcome = { status: "blocked", reason: "No complete Codex turn was observed." };
  let workerObserved = false;
  const redact = (text: string) => sensitiveValues.filter(Boolean).reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), text);
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = object(JSON.parse(line));
    } catch {
      return { outcome: { status: "blocked", reason: "Codex emitted malformed JSONL." }, actions, usage };
    }
    if (event.type === "turn.completed") {
      const native = object(event.usage);
      const parsed = usageSchema.safeParse({ metering: "reported", inputTokens: native.input_tokens, outputTokens: native.output_tokens });
      if (parsed.success) usage = parsed.data;
      outcome = { status: "passed" };
    } else if (event.type === "turn.failed") {
      outcome = { status: "blocked", reason: "The native Codex turn failed before completing execution." };
    } else if (event.type === "item.completed") {
      const item = object(event.item);
      if (item.type === "collab_tool_call" && array(item.receiver_thread_ids).length > 0) {
        workerObserved = true;
      } else if (item.type === "command_execution" && typeof item.command === "string") {
        actions.push({
          kind: "command", command: redact(item.command),
          ...(Number.isSafeInteger(item.exit_code) ? { exitCode: item.exit_code as number } : {}),
        });
      } else if (item.type === "file_change") {
        for (const change of array(item.changes).map(object)) {
          if (typeof change.path === "string" && (change.kind === "add" || change.kind === "delete" || change.kind === "update")) {
            actions.push({ kind: "file-change", path: redact(change.path), change: change.kind });
          }
        }
      }
    }
  }
  if (workerObserved) usage = { metering: "unknown", reason: "Codex parent counters do not include native worker token usage." };
  return { outcome, actions, usage };
}

export interface CodexBackendOptions {
  program: string;
  /** The shared EvidenceStore archive root, outside the disposable model workspace.
   * Returned artifact locations are relative to this directory.
   */
  artifacts: string;
  bundle?: CodexBundle;
  /** An explicitly vetted provider configuration, used unchanged in each trial. */
  configToml?: string;
  environment?: Readonly<Record<string, string>>;
}

function inside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
}

/** Translate one already-staged benchmark attempt into a bounded codex exec invocation. */
export function createCodexBackend(options: CodexBackendOptions): BenchmarkBackend {
  return { async run(rawRequest, callerSignal) {
    const request = backendRequestSchema.parse(rawRequest);
    const start = performance.now();
    const timed = AbortSignal.timeout(Math.min(request.timeoutMs, 2_147_483_647));
    const signal = AbortSignal.any([callerSignal, timed]);
    let scope: string | undefined;
    let host: typeof request.host | undefined;
    const artifacts: { kind: string; location: string; digest: string }[] = [];
    let usage: Usage = { metering: "unknown", reason: "Codex did not report validated token usage." };
    const result = (outcome: EvidenceOutcome) => backendResultSchema.parse({
      requestId: request.id, outcome, durationMs: performance.now() - start, artifacts, usage,
      ...(host === undefined ? {} : { host }),
    });
    if (callerSignal.aborted) return result({ status: "not_run", reason: "The Codex attempt was cancelled before launch." });
    if (!supportedCodexHost(request.host) || process.platform !== request.host.os) {
      return result({ status: "blocked", reason: "The requested Codex surface, version, or platform is unsupported." });
    }
    try {
      const workspace = await realpath(request.workspace);
      const artifactsRoot = resolve(options.artifacts);
      if (inside(workspace, artifactsRoot)) return result({ status: "blocked", reason: "Codex artifacts must remain outside the disposable workspace." });
      scope = await mkdtemp(join(tmpdir(), "axiom-codex-profile-"));
      const profile: CodexProfile = {
        program: options.program,
        home: join(scope, "codex"),
        userHome: join(scope, "home"),
        workspace,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      };
      await mkdir(profile.home);
      await mkdir(profile.userHome);
      if (options.configToml) await writeFile(join(profile.home, "config.toml"), options.configToml, { flag: "wx", mode: 0o600 });
      const native = await nativeVersion(profile, signal);
      if (native !== request.host.version) return result({ status: "blocked", reason: "Installed Codex does not match the requested version." });
      host = { ...request.host, version: native };
      if (request.mode === "with_axiom") {
        const bundle = options.bundle;
        if (!bundle || bundle.policy.digest !== request.policy.digest) {
          return result({ status: "blocked", reason: "The requested policy digest does not match an available Codex bundle." });
        }
        await configureCodexProfile(profile, "install", bundle, signal);
        const status = await observeCodexProfile(profile, signal);
        if (!status.discovered || !status.selected
          || !status.contexts.some((context) => context.includes(bundle.instructions))
          || !bundle.skills.every((name) => status.skills.includes(`axiom:${name}`))) {
          return result({ status: "blocked", reason: "Native Codex policy or skill loading could not be observed." });
        }
      }
      const execution = await runCodex(profile, [
        "--ask-for-approval", "never", "exec", "--sandbox", "workspace-write", "--ephemeral",
        "--skip-git-repo-check", "--color", "never", "--json", "--model", request.host.model, "-",
      ], { input: request.prompt, signal });
      const secrets = Object.entries(options.environment ?? {})
        .filter(([name]) => /(?:secret|token|key|password|auth)/i.test(name)).map(([, value]) => value);
      const trace = parseCodexTrace(execution.stdout, secrets);
      usage = trace.usage;
      await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
      const storage = await realpath(artifactsRoot);
      if (inside(workspace, storage)) return result({ status: "blocked", reason: "Codex artifacts resolve into the disposable workspace." });
      const location = `${request.id}.${randomUUID()}.json`;
      const serialized = JSON.stringify({ actions: trace.actions }) + "\n";
      await writeFile(join(storage, location), serialized, { flag: "wx", mode: 0o600 });
      artifacts.push({ kind: "action-trace", location, digest: digest(serialized) });
      if (execution.code !== 0) return result({ status: "blocked", reason: "The native Codex CLI exited before completing the attempt." });
      return result(trace.outcome);
    } catch {
      if (callerSignal.aborted) return result({ status: "blocked", reason: "The native Codex attempt was cancelled." });
      if (timed.aborted) return result({ status: "blocked", reason: "The native Codex attempt exceeded its time limit." });
      return result({ status: "blocked", reason: "The native Codex attempt could not be staged, executed, or recorded." });
    } finally {
      if (scope) await rm(scope, { recursive: true, force: true });
    }
  } };
}
