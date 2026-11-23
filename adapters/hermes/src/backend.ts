import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backendRequestSchema, backendResultSchema } from "@axiom/contracts";
import type { BackendRequest, BackendResult, BenchmarkBackend, EvidenceOutcome } from "@axiom/contracts";
import { EvidenceStore } from "@axiom/evidence";
import { hermesVersion } from "./bundle.js";
import { inspectHermesActivation, profileDirectory } from "./profile.js";
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
  /** Explicit launcher environment. Ambient provider credentials are excluded. */
  environment?: NodeJS.ProcessEnv;
}

interface Trace {
  model: string;
  session: string;
  exitCode: number;
  calls: Record<string, unknown>[];
  usage: BackendResult["usage"];
}

const unknownUsage = { metering: "unknown", reason: "Hermes did not expose measured token usage." } as const;

function safeLabel(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value);
}

function normalize(stdout: string): Trace | undefined {
  let model: string | undefined;
  let terminal: { session: string; exitCode: number; usage: Trace["usage"] } | undefined;
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
      if (!safeLabel(event.session_id) || !Number.isInteger(event.exit_code) || event.exit_code < 0) return;
      const input: unknown = event.tokens?.input;
      const output: unknown = event.tokens?.output;
      const reported = typeof input === "number" && Number.isSafeInteger(input) && input >= 0
        && typeof output === "number" && Number.isSafeInteger(output) && output >= 0 && (input > 0 || output > 0);
      terminal = { session: event.session_id, exitCode: event.exit_code, usage: reported
        ? { metering: "reported", inputTokens: input, outputTokens: output } : unknownUsage };
    }
  }
  if (terminal && model) return { ...terminal, model, calls };
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
      const activation = inspectHermesActivation(profile);
      if (activation.installed.status === "blocked") return blocked("The Hermes profile activation could not be inspected.");
      if (request.mode === "with_axiom" && (!activation.enabled || activation.policy?.digest !== request.policy.digest
        || activation.loaded.status === "blocked")) {
        return blocked("The requested Axiom activation is unavailable in the selected Hermes profile.");
      }
      if (request.mode === "without_axiom" && activation.enabled) {
        return blocked("The baseline profile has Axiom enabled.");
      }
      const env = {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        ...this.options.environment,
        HOME: home, HERMES_HOME: home,
        HERMES_TUI_GATEWAY_URL: "",
        AXIOM_HERMES_NODE: process.execPath,
        AXIOM_HERMES_CHECKER: fileURLToPath(new URL("./hook-entry.js", import.meta.url)),
        AXIOM_HERMES_ARCHIVE: archiveDirectory,
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
      const gateway = await openHermesGateway({
        ...base, args: [...this.options.arguments ?? [], "gateway", "run", "--no-supervise", "--external-supervisor"],
      }, home, profile.profile);
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

      const directory = join(archiveDirectory, "hermes");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const name = `${request.id}-${randomUUID()}.json`;
      await writeFile(join(directory, name), JSON.stringify(trace) + "\n", { flag: "wx", mode: 0o600 });
      const artifact = await new EvidenceStore(archiveDirectory).artifact({ kind: "hermes-trace", path: "hermes/" + name });
      if (!artifact) return blocked("The normalized Hermes trace could not be archived.");
      const evidence = { host: request.host, artifacts: [artifact], usage: trace.usage };
      if (returned.code !== 0) return result({ status: "failed", reason: "Hermes reported unsuccessful native execution." }, evidence);
      if (signal.aborted) return result({ status: "blocked", reason: "Hermes execution was cancelled." }, evidence);
      if (request.mode === "with_axiom" && inspectHermesActivation(profile, trace.session).loaded.status !== "passed") {
        return result({ status: "blocked", reason: "Hermes did not observe Axiom policy loading in the benchmark session." }, evidence);
      }
      return result({ status: "passed" }, evidence);
    } catch {
      return blocked("The selected Hermes profile, staged workspace, or execution evidence was unavailable.");
    }
  }
}
