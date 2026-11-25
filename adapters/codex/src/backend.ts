import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backendRequestSchema, backendResultSchema, usageSchema, type BenchmarkBackend, type EvidenceOutcome, type Usage } from "@axiom/contracts";
import { supportedCodexHost } from "./activation.js";
import { digest, type CodexBundle } from "./bundle.js";
import { runCodexPlan, type CodexPlanObserver } from "./clarification.js";
import { configureCodexProfile, observeCodexProfile } from "./profile.js";
import { array, nativeJson, nativeVersion, object, runCodex, type CodexProfile } from "./process.js";

type NormalizedAction =
  | { kind: "command"; command: string; exitCode?: number }
  | { kind: "file-change"; path: string; change: "add" | "delete" | "update" };

export interface CodexTrace {
  outcome: EvidenceOutcome;
  actions: NormalizedAction[];
  usage: Usage;
}

const providerFailureReasons = {
  model: "The native Codex provider rejected the requested model.",
  access: "The native Codex provider refused access to the request.",
  rateLimit: "The native Codex provider rate-limited the request.",
};

const chatGptModelRejection = /^The '[\w][\w./:-]{0,159}' model is not supported when using Codex with a ChatGPT account\.$/;
const missingModel = /^The model `[\w][\w./:-]{0,159}` does not exist or you do not have access to it\.$/;

function providerFailure(message: unknown): string | undefined {
  if (typeof message !== "string") return;
  // Inspect only known native status prefixes or a small error envelope. Report fixed reasons.
  const prefix = message.slice(0, 128).trimStart();
  if (/^unexpected status (?:401 Unauthorized|403 Forbidden)(?::|,|$)/.test(prefix)) return providerFailureReasons.access;
  if (/^(?:unexpected status |exceeded retry limit, last status: )429 Too Many Requests(?::|,|$)/.test(prefix)) {
    return providerFailureReasons.rateLimit;
  }
  if (message.length > 4096) return;
  const text = message.trim();
  if (chatGptModelRejection.test(text) || missingModel.test(text)) return providerFailureReasons.model;
  if (!text.startsWith("{")) return;
  try {
    const error = object(object(JSON.parse(text)).error);
    if (error.code === "unsupported_model" || error.code === "model_not_found" ||
        (typeof error.message === "string" && (chatGptModelRejection.test(error.message) || missingModel.test(error.message)))) {
      return providerFailureReasons.model;
    }
  } catch { /* Unrecognized terminal diagnostics stay generic. */ }
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
      outcome = { status: "blocked", reason: providerFailure(object(event.error).message) ?? "The native Codex turn failed before completing execution." };
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
  /** Reuse a native ChatGPT file-store login with an otherwise disposable home. */
  authHome?: string;
  /** Observe local preview isolation for this reviewed native-account case. */
  previewCaseId?: string;
  /** Normalize source-bound Plan-mode observations before archiving them. */
  planClarification?: CodexPlanObserver;
}

function inside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
}

const standardPermissions = "axiom-benchmark";

async function stageGitMountPoint(workspace: string) {
  const path = join(workspace, ".git");
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    // A caller's existing repository is never owned by the adapter.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  const original = await lstat(path, { bigint: true });
  return async () => {
    const current = await lstat(path, { bigint: true }).catch(() => undefined);
    if (current?.isDirectory() && current.dev === original.dev && current.ino === original.ino) {
      // rmdir preserves a populated mount for the fixture verifier to reject.
      await rmdir(path).catch(() => {});
    }
  };
}

/** The npm launcher starts a platform binary that the native sandbox needs to be able to re-execute. */
export async function resolveCodexAccountProgram(program: string): Promise<string> {
  const executable = await realpath(program);
  const bin = dirname(executable);
  if (basename(executable) !== "codex.js" || basename(bin) !== "bin") return executable;
  const packageRoot = dirname(bin);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (manifest?.name !== "@openai/codex") return executable;
  const machine = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : undefined;
  if (process.platform !== "linux" || !machine) throw new Error("The standard Codex npm platform executable is unsupported.");
  const vendorRoots = [join(packageRoot, "vendor")];
  const fromLauncher = createRequire(executable);
  try {
    const installed = fromLauncher.resolve(`@openai/codex-linux-${process.arch}/package.json`);
    vendorRoots.unshift(join(dirname(installed), "vendor"));
  } catch { /* Some distributions ship the executable in the wrapper package. */ }
  for (const vendor of vendorRoots) {
    const binary = join(vendor, `${machine}-unknown-linux-musl`, "bin", "codex");
    if (await access(binary, constants.X_OK).then(() => true, () => false)) return realpath(binary);
  }
  throw new Error("The installed Codex npm package lacks its platform executable.");
}

async function prepareNativeAuth(profile: CodexProfile, authHome: string, archive: string, signal: AbortSignal, preview: boolean, plan: boolean) {
  const source = await realpath(authHome);
  const credential = join(source, "auth.json");
  if (inside(profile.workspace, source) || inside(source, profile.workspace) ||
      inside(archive, source) || inside(source, archive) ||
      !(await lstat(credential).catch(() => undefined))?.isFile()) {
    return "A separate Codex home containing native file-store authentication is required.";
  }
  const link = join(profile.home, "auth.json");
  // Codex owns reads and atomic OAuth refreshes through this link. Axiom never copies the store.
  await symlink(credential, link, "file");
  await writeFile(join(profile.home, "config.toml"), [
    'cli_auth_credentials_store = "file"',
    `default_permissions = "${standardPermissions}"`,
    ...(preview || plan ? ['web_search = "disabled"'] : []),
    "[features]",
    "apps = false",
    "[analytics]",
    "enabled = false",
    `[permissions.${standardPermissions}.filesystem]`,
    '":minimal" = "read"',
    `":workspace_roots" = "${plan ? "read" : "write"}"`,
    `${JSON.stringify(profile.program)} = "read"`,
    ...(plan ? ['"/usr/bin/cat" = "read"', '"/usr/bin/sed" = "read"', '"/usr/bin/ls" = "read"', '"/usr/bin/readlink" = "read"'] : []),
    `[permissions.${standardPermissions}.network]`,
    "enabled = false",
    "[shell_environment_policy]",
    'inherit = "none"',
    ...(plan ? ["[shell_environment_policy.set]", 'PATH = "/usr/bin:/bin"'] : []),
    "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  const login = await runCodex(profile, ["login", "status"], { signal, captureStderr: true });
  if (login.code !== 0 || !login.stderr?.split(/\r?\n/).includes("Logged in using ChatGPT")) {
    return "This Codex profile must use a native ChatGPT file-store login.";
  }
  const probe = await runCodex(profile, [
    "sandbox", "-P", standardPermissions, "--include-managed-config", "-C", profile.workspace, "--",
    "/bin/sh", "-c", `${plan ? 'test -r "$1/issue.txt" && ! test -w "$1"' : 'test -w "$1"'} && ! test -r "$2" && ! test -r "$3" && ! test -r "$4"`,
    "axiom", profile.workspace, credential, link, archive,
  ], { signal });
  if (probe.code !== 0) return "Codex could not confirm that its tool sandbox protects the credential and archive.";
}

async function hasIsolatedPreviewBoundary(profile: CodexProfile, signal: AbortSignal) {
  const mcp = await nativeJson(profile, ["mcp", "list", "--json"], signal);
  if (!Array.isArray(mcp) || mcp.length !== 0) return false;
  const hostNamespace = await readlink("/proc/self/ns/net");
  const sandbox = await runCodex(profile, ["sandbox", "-P", standardPermissions, "--include-managed-config", "-C", profile.workspace,
    "--", "/usr/bin/readlink", "/proc/self/ns/net"], { signal });
  const namespace = /^net:\[\d+\]$/;
  const sandboxNamespace = sandbox.stdout.trim();
  return sandbox.code === 0 && namespace.test(hostNamespace) && namespace.test(sandboxNamespace) && sandboxNamespace !== hostNamespace;
}

/** Translate one already-staged benchmark attempt into a bounded codex exec invocation. */
export function createCodexBackend(options: CodexBackendOptions): BenchmarkBackend {
  return { async run(rawRequest, callerSignal) {
    const request = backendRequestSchema.parse(rawRequest);
    const start = performance.now();
    const timed = AbortSignal.timeout(Math.min(request.timeoutMs, 2_147_483_647));
    const signal = AbortSignal.any([callerSignal, timed]);
    let scope: string | undefined;
    let removeGitMount: (() => Promise<void>) | undefined;
    let host: typeof request.host | undefined;
    const artifacts: { kind: string; location: string; digest: string }[] = [];
    let usage: Usage = { metering: "unknown", reason: "Codex did not report validated token usage." };
    const result = (outcome: EvidenceOutcome) => backendResultSchema.parse({
      requestId: request.id, outcome, durationMs: performance.now() - start, artifacts, usage,
      ...(host === undefined ? {} : { host }),
    });
    if (callerSignal.aborted) return result({ status: "not_run", reason: "The Codex attempt was cancelled before launch." });
    const plan = request.host.surface === "app-server-plan";
    if (!supportedCodexHost(plan ? { ...request.host, surface: "cli" } : request.host) || process.platform !== request.host.os ||
        (plan && (!options.planClarification || !options.authHome))) {
      return result({ status: "blocked", reason: "The requested Codex surface, version, or platform is unsupported." });
    }
    try {
      const workspace = await realpath(request.workspace);
      const artifactsRoot = resolve(options.artifacts);
      if (inside(workspace, artifactsRoot)) return result({ status: "blocked", reason: "Codex artifacts must remain outside the disposable workspace." });
      const { authHome } = options;
      const preview = request.caseId === options.previewCaseId;
      if (preview && !authHome) return result({ status: "blocked", reason: "The Codex browser preview boundary requires the native-account sandbox." });
      if (authHome !== undefined && (!isAbsolute(authHome) || options.configToml !== undefined || options.environment !== undefined)) {
        return result({ status: "blocked", reason: "Supply an absolute Codex auth home without provider or environment overrides." });
      }
      scope = await mkdtemp(join(tmpdir(), "axiom-codex-profile-"));
      const profile: CodexProfile = {
        program: authHome ? await resolveCodexAccountProgram(options.program) : options.program,
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
      if (authHome) {
        // Bubblewrap creates this mount on the host. Own its empty directory before Codex starts any sandbox.
        removeGitMount = await stageGitMountPoint(workspace);
        const unavailable = await prepareNativeAuth(profile, authHome, artifactsRoot, signal, preview, plan);
        if (unavailable) return result({ status: "blocked", reason: unavailable });
      }
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
      if (preview && !await hasIsolatedPreviewBoundary(profile, signal).catch(() => false)) {
        return result({ status: "blocked", reason: "Codex did not establish a separate tool network and an empty MCP inventory." });
      }
      if (plan) {
        if (!await hasIsolatedPreviewBoundary(profile, signal).catch(() => false)) {
          return result({ status: "blocked", reason: "Codex Plan mode could not establish a separate tool network and an empty MCP inventory." });
        }
        const observation = await runCodexPlan(profile, request, signal, options.planClarification!);
        if (!observation) return result({ status: "blocked", reason: "Codex Plan mode did not return a complete native observation." });
        const location = `${request.id}.clarification.json`;
        const body = JSON.stringify({ requestId: request.id, surface: request.host.surface, ...observation }) + "\n";
        await writeFile(join(artifactsRoot, location), body, { flag: "wx", mode: 0o600 });
        artifacts.push({ kind: "native-clarification", location, digest: digest(body) });
        return result({ status: "passed" });
      }
      const execution = await runCodex(profile, [
        "--ask-for-approval", "never", "exec", ...(authHome ? ["--ignore-rules"] : ["--sandbox", "workspace-write"]), "--ephemeral",
        "--skip-git-repo-check", "--color", "never", "--json", "--model", request.host.model, "-",
      ], { input: request.prompt, signal });
      const secrets = Object.entries(options.environment ?? {})
        .filter(([name]) => /(?:secret|token|key|password|auth)/i.test(name)).map(([, value]) => value);
      const trace = parseCodexTrace(execution.stdout, secrets);
      usage = trace.usage;
      if (!authHome) {
        await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
        const storage = await realpath(artifactsRoot);
        if (inside(workspace, storage)) return result({ status: "blocked", reason: "Codex artifacts resolve into the disposable workspace." });
        const location = `${request.id}.${randomUUID()}.json`;
        const serialized = JSON.stringify({ actions: trace.actions }) + "\n";
        await writeFile(join(storage, location), serialized, { flag: "wx", mode: 0o600 });
        artifacts.push({ kind: "action-trace", location, digest: digest(serialized) });
      }
      if (execution.code !== 0 && (trace.outcome.status !== "blocked" || !Object.values(providerFailureReasons).includes(trace.outcome.reason))) {
        return result({ status: "blocked", reason: "The native Codex CLI exited before completing the attempt." });
      }
      if (preview && execution.code === 0 && trace.outcome.status === "passed") {
        const location = `${request.id}.preview.json`;
        const body = JSON.stringify({ requestId: request.id, mcpServers: 0, networkNamespace: "isolated" }) + "\n";
        await writeFile(join(artifactsRoot, location), body, { flag: "wx", mode: 0o600 });
        artifacts.push({ kind: "native-preview-boundary", location, digest: digest(body) });
      }
      return result(trace.outcome);
    } catch {
      if (callerSignal.aborted) return result({ status: "blocked", reason: "The native Codex attempt was cancelled." });
      if (timed.aborted) return result({ status: "blocked", reason: "The native Codex attempt exceeded its time limit." });
      return result({ status: "blocked", reason: "The native Codex attempt could not be staged, executed, or recorded." });
    } finally {
      await removeGitMount?.();
      if (scope) await rm(scope, { recursive: true, force: true });
    }
  } };
}
