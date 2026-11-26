import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backendRequestSchema, backendResultSchema } from "@axiom/contracts";
import type { BackendRequest, BackendResult, BenchmarkBackend, EvidenceOutcome } from "@axiom/contracts";
import { EvidenceStore } from "@axiom/evidence";
import { hermesVersion } from "./bundle.js";
import { inspectHermesActivation, inspectHermesHookFailure, profileDirectory } from "./profile.js";
import type { HermesProfile } from "./profile.js";
import { openHermesGateway, runHermes } from "./process.js";

export interface HermesBackendOptions {
  executable: string;
  /** Prefix arguments for a caller-provided isolated runtime launcher. */
  arguments?: readonly string[];
  profile: HermesProfile;
  archiveDirectory: string;
  provider: string;
  maxTurns: number;
  baseUrl?: string;
  standalone?: boolean;
  toolsets?: readonly string[];
  /** Explicit launcher environment. Ambient provider credentials are excluded. */
  environment?: NodeJS.ProcessEnv;
  /** Observe local preview isolation for this reviewed native-account case. */
  previewCaseId?: string;
}

interface Trace {
  model: string;
  session: string;
  exitCode: number;
  calls: Record<string, unknown>[];
  usage: BackendResult["usage"];
}

interface PreSessionFailure {
  model: string;
  exitCode: number;
  startupFailure: string;
}

const unknownUsage = { metering: "unknown", reason: "Hermes did not expose measured token usage." } as const;

function contains(root: string, path: string): boolean {
  const offset = relative(root, path);
  return !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
}

function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

// Resolve any existing symlink parents before creating the caller's archive directories.
async function prospectivePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
    return join(await prospectivePath(parent), basename(path));
  }
}

function safeLabel(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value);
}

function preSessionReason(error: unknown): string {
  // Hermes discovery can append local paths and repair commands. Retain only fixed reasons.
  const discovery = typeof error === "string"
    ? /^Gateway (?:inaccessible|incompatible|starting): ([a-z_]+)(?: \([\s\S]*\))?$/.exec(error)?.[1]
    : undefined;
  switch (discovery ?? error) {
    case "credentials or agent init failed":
      return "Hermes reported a credential or agent initialization failure before establishing a session.";
    case "authorization":
    case "unsafe_control_path":
    case "unsafe_control_peer":
    case "unsafe_control_permissions":
    case "unsafe_control_pointer":
      return "Hermes refused access to the local gateway control channel before establishing a session.";
    case "Gateway connection failed; no local fallback":
    case "Gateway connection/read failed; no local fallback":
    case "control_timeout":
    case "deadline":
      return "Hermes could not reach or communicate with the local gateway before establishing a session.";
    case "workspace_unavailable":
      return "The Hermes gateway could not access the disposable workspace before establishing a session.";
    case "storage_unavailable":
      return "The Hermes gateway could not access session storage before establishing a session.";
    case "invalid_params":
    case "permission_denied":
    case "profile_mismatch":
      return "The Hermes gateway rejected the native session startup request.";
    case "launch_credentials_unavailable":
      return "The Hermes gateway could not access launch credentials before establishing a session.";
    default:
      return "The native Hermes run failed before establishing a session.";
  }
}

function normalize(stdout: string): Trace | PreSessionFailure | undefined {
  let model: string | undefined;
  let terminal: Pick<Trace, "session" | "exitCode" | "usage"> | Omit<PreSessionFailure, "model"> | undefined;
  const calls: Trace["calls"] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    if (terminal) return;
    const event = JSON.parse(line);
    if (event?.type === "system" && event.subtype === "init") {
      if (model || !safeLabel(event.model)) return;
      model = event.model;
    } else if ((event?.type === "tool_use" || event?.type === "tool_result") && safeLabel(event.name)) {
      calls.push({
        type: event.type, name: event.name,
        ...(safeLabel(event.tool_call_id) && { id: event.tool_call_id }),
        ...(typeof event.is_error === "boolean" && { failed: event.is_error }),
      });
    } else if (event?.type === "result") {
      if (!Number.isInteger(event.exit_code) || event.exit_code < 0) return;
      if (event.session_id === "" && event.exit_code > 0) {
        terminal = { exitCode: event.exit_code, startupFailure: preSessionReason(event.error) };
        continue;
      }
      if (!safeLabel(event.session_id)) return;
      const input: unknown = event.tokens?.input;
      const output: unknown = event.tokens?.output;
      const reported = typeof input === "number" && Number.isSafeInteger(input) && input >= 0
        && typeof output === "number" && Number.isSafeInteger(output) && output >= 0 && (input > 0 || output > 0);
      terminal = { session: event.session_id, exitCode: event.exit_code, usage: reported
        ? { metering: "reported", inputTokens: input, outputTokens: output } : unknownUsage };
    }
  }
  if (terminal && model) {
    if ("startupFailure" in terminal) return { ...terminal, model };
    const usage: Trace["usage"] = calls.some(({ name }) => name === "delegate_task")
      ? { metering: "unknown", reason: "Hermes terminal usage excludes delegated worker tokens." }
      : terminal.usage;
    return { ...terminal, model, calls, usage };
  }
}

/** Run an independently staged case through Hermes' native one-shot JSONL interface. */
export class HermesBenchmarkBackend implements BenchmarkBackend {
  constructor(private readonly options: HermesBackendOptions) {}

  async run(input: BackendRequest, signal: AbortSignal): Promise<BackendResult> {
    const request = backendRequestSchema.parse(input);
    const started = performance.now();
    const deadline = started + request.timeoutMs;
    const result = (
      outcome: EvidenceOutcome,
      observed?: Pick<BackendResult, "host" | "artifacts" | "usage">,
    ) => backendResultSchema.parse({
      requestId: request.id, durationMs: performance.now() - started, outcome,
      artifacts: [], usage: unknownUsage, ...observed,
    });
    const blocked = (reason: string) => result({ status: "blocked", reason });
    if (signal.aborted) return blocked("Hermes execution was cancelled.");
    if (request.host.agent !== "hermes" || request.host.version !== hermesVersion || request.host.surface !== "cli"
      || request.host.os !== process.platform) return blocked("The requested Hermes host identity is outside this adapter's version and surface.");
    const { profile, executable, provider, maxTurns, archiveDirectory } = this.options;
    if (!provider.trim() || !Number.isSafeInteger(maxTurns) || maxTurns < 1
      || request.timeoutMs > 2_147_483_647) return blocked("Hermes requires a named provider and positive bounded run limits.");

    try {
      const cwd = await realpath(request.workspace);
      const selected = profileDirectory(profile);
      const home = dirname(dirname(selected));
      if (overlaps(cwd, await realpath(home))) return blocked("The Hermes profile home overlaps the disposable workspace.");
      const requestedArchive = resolve(archiveDirectory);
      const storage = await prospectivePath(requestedArchive);
      if (overlaps(cwd, requestedArchive) || overlaps(cwd, storage)) {
        return blocked("The Hermes evidence archive overlaps the disposable workspace.");
      }
      const traceDirectory = join(storage, "hermes");
      const checksDirectory = join(storage, "acceptance");
      for (const directory of [traceDirectory, checksDirectory]) {
        if (await prospectivePath(directory) !== directory) return blocked("The Hermes evidence archive has a redirected subdirectory.");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (await realpath(directory) !== directory) return blocked("The Hermes evidence archive has a redirected subdirectory.");
      }
      const activation = inspectHermesActivation(profile);
      const useAxiom = request.mode === "with_axiom";
      const { bundleDigest } = activation;
      if (activation.installed.status === "blocked") return blocked("The Hermes profile activation could not be inspected.");
      if (useAxiom && (!bundleDigest || !activation.enabled || activation.policy?.digest !== request.policy.digest
        || activation.loaded.status === "blocked")) {
        return blocked("The requested Axiom activation is unavailable in the selected Hermes profile.");
      }
      if (!useAxiom && activation.enabled) {
        return blocked("The baseline profile has Axiom enabled.");
      }
      const env = {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        ...this.options.environment,
        HOME: home, HERMES_HOME: home,
        HERMES_TUI_GATEWAY_URL: "",
        AXIOM_HERMES_NODE: process.execPath,
        AXIOM_HERMES_ARCHIVE: storage,
      };
      const base = { executable, cwd, env, deadline, signal };
      const scope = [...this.options.arguments ?? [], "--profile", profile.profile];
      const interrupt = (reason: string) => blocked(
        reason === "cancelled" ? "Hermes execution was cancelled."
          : reason === "timeout" ? "The Hermes run time limit was reached."
          : reason === "output-limit" ? "The Hermes trace output limit was reached."
          : "The Hermes executable is unavailable.",
      );

      const version = await runHermes({ ...base, args: [...scope, "--version"] });
      if (version.interrupted) return interrupt(version.interrupted);
      if (version.code !== 0 || /Hermes Agent v([^\s)]+)/.exec(version.stdout)?.[1] !== request.host.version) {
        return blocked("The native Hermes version could not be matched to the requested version.");
      }
      const preview = request.caseId === this.options.previewCaseId;
      if (preview) {
        const inventory = await runHermes({ ...base, args: [...scope, "tools", "list", "--platform", "cli"] });
        const enabled = [...inventory.stdout.matchAll(/^\s*✓\s+enabled\s+(\S+)/gm)].map((match) => match[1]).sort();
        if (inventory.code !== 0 || enabled.join(",") !== "file,skills" || !/^\s*✗\s+disabled\s+browser\s/m.test(inventory.stdout)
            || this.options.toolsets?.join(",") !== "file,skills" || !this.options.standalone) {
          return blocked("Hermes did not establish a standalone file-and-skills tool surface with browser disabled.");
        }
      }
      const gateway = await openHermesGateway({
        ...base, args: [...(this.options.standalone ? scope : this.options.arguments ?? []),
          "gateway", "run", "--no-supervise", "--external-supervisor"],
      }, this.options.standalone ? selected : home, profile.profile, this.options.standalone);
      if ("interrupted" in gateway) return gateway.interrupted === "unavailable"
        ? blocked("The owned Hermes foreground gateway did not start.") : interrupt(gateway.interrupted);
      let returned;
      try {
        returned = await runHermes({
          ...base, input: request.prompt, signal: AbortSignal.any([signal, gateway.signal]),
          args: [
            ...scope, "chat", "--query-file", "-", "--format", "stream-json",
            "--model", request.host.model, "--provider", provider,
            "--max-turns", String(maxTurns),
            ...(this.options.toolsets ? ["--toolsets", this.options.toolsets.join(",")] : []),
            ...(this.options.baseUrl ? ["--base-url", this.options.baseUrl] : []),
          ],
        });
        if (gateway.signal.aborted && !signal.aborted) {
          return blocked("The owned Hermes foreground gateway exited during execution.");
        }
      } finally {
        await gateway.stop();
      }
      if (returned.interrupted) return interrupt(returned.interrupted);
      let trace;
      try {
        trace = normalize(returned.stdout);
      } catch { /* A partial or nonnative stream cannot prove successful execution. */ }
      if (!trace || trace.model !== request.host.model || trace.exitCode !== returned.code) {
        return blocked("The Hermes stream lacked a matching native model and terminal result.");
      }
      if ("startupFailure" in trace) return blocked(trace.startupFailure);

      if (await realpath(traceDirectory) !== traceDirectory) return blocked("The Hermes trace archive changed during execution.");
      const name = `${request.id}-${randomUUID()}.json`;
      await writeFile(join(traceDirectory, name), JSON.stringify(trace) + "\n", { flag: "wx", mode: 0o600 });
      const artifact = await new EvidenceStore(storage).artifact({ kind: "hermes-trace", path: "hermes/" + name });
      if (!artifact) return blocked("The normalized Hermes trace could not be archived.");
      const evidence = { host: request.host, artifacts: [artifact], usage: trace.usage };
      if (signal.aborted) return result({ status: "blocked", reason: "Hermes execution was cancelled." }, evidence);
      if (useAxiom && bundleDigest) {
        const hookFailure = inspectHermesHookFailure(profile, bundleDigest, trace.session);
        if (hookFailure) return result(hookFailure, evidence);
      }
      if (returned.code !== 0) return result({ status: "failed", reason: "Hermes reported unsuccessful native execution." }, evidence);
      if (useAxiom) {
        const observed = inspectHermesActivation(profile, trace.session);
        if (observed.bundleDigest !== bundleDigest) {
          return result({ status: "blocked", reason: "Hermes did not observe Axiom policy loading in the benchmark session." }, evidence);
        }
        if (observed.loaded.status !== "passed") return result({ status: "blocked", reason: observed.loaded.reason }, evidence);
      }
      if (preview) {
        const location = `${request.id}.preview.json`;
        await writeFile(join(storage, location), JSON.stringify({ requestId: request.id, enabledToolsets: ["file", "skills"],
          browser: "disabled" }) + "\n", { flag: "wx", mode: 0o600 });
        const boundary = await new EvidenceStore(storage).artifact({ kind: "native-preview-boundary", path: location });
        if (!boundary) return blocked("The independently observed Hermes preview boundary could not be archived.");
        evidence.artifacts.push(boundary);
      }
      return result({ status: "passed" }, evidence);
    } catch {
      return blocked("The selected Hermes profile, staged workspace, or execution evidence was unavailable.");
    }
  }
}
