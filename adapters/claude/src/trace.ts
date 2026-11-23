import { capabilitySchema, digestSchema, taskBriefSchema, usageSchema, type Capability, type EvidenceOutcome, type HostIdentity, type Usage } from "@axiom/contracts";
import { pluginId, supportedVersion, type ClaudeBundle } from "./bundle.js";
import { array, object } from "./runtime.js";

type Action = { kind: "read" | "edit"; path: string } | { kind: "command"; command: string };

export interface ClaudeSessionObservation {
  discovered: boolean;
  selected: boolean;
  observedVersion?: string;
  observedModel?: string;
  skills: string[];
  policyDigests: string[];
  observedWorkerIds?: string[];
}

export function supportedClaudeHost(host: HostIdentity) {
  return host.agent === "claude" && host.os === "linux" && host.version === supportedVersion && host.surface === "cli";
}

export function claudeCapabilities(host: HostIdentity, observation?: ClaudeSessionObservation): Capability[] {
  const native = supportedClaudeHost(host);
  return [
    ...["native-package", "startup", "process-execution", "action-trace"].map((id) => capabilitySchema.parse(native
      ? { id, available: true } : { id, available: false, reason: "Unsupported Claude Code surface, version, or platform." })),
    ...["resume", "compaction", "hook-enforcement"].map((id): Capability => ({
      id, available: false, reason: `Observable ${id} coverage is unavailable on the declared Claude CLI surface.`,
    })),
    observation?.observedWorkerIds?.length && native ? { id: "delegation", available: true } : {
      id: "delegation", available: false, reason: "No validated native subagent brief was observed.",
    },
  ];
}

export function assessClaudeActivation(
  bundle: ClaudeBundle, host: HostIdentity, observation: ClaudeSessionObservation, required: readonly string[] = [],
) {
  const loading = observation.policyDigests.includes(bundle.manifest.policy.digest)
    && bundle.manifest.skills.every(({ id }) => observation.skills.includes(`axiom:${id}`));
  const capabilities = claudeCapabilities(host, observation);
  const missing = required.find((id) => !capabilities.some((capability) => capability.id === id && capability.available));
  let outcome: EvidenceOutcome = { status: "passed" };
  if (!supportedClaudeHost(host) || observation.observedVersion !== host.version) {
    outcome = { status: "blocked", reason: "The observed Claude Code surface or version is unsupported." };
  } else if (!observation.discovered || !observation.selected || !loading) {
    outcome = { status: "blocked", reason: "Claude plugin discovery, selection, or context loading was not observed." };
  } else if (missing) {
    outcome = { status: "blocked", reason: `The required Claude capability is unavailable: ${missing}.` };
  }
  return { discovery: observation.discovered, selection: observation.selected, loading, capabilities, outcome };
}

function readHookContext(raw: unknown) {
  if (typeof raw !== "string") return;
  try {
    const { hookSpecificOutput } = object(JSON.parse(raw));
    return object(hookSpecificOutput);
  } catch { /* Other native hooks can return plain stdout. */ }
}

export function parseClaudeTrace(raw: string, sensitiveValues: readonly string[] = []) {
  const actions: Action[] = [];
  const pendingTools = new Map<string, Action>();
  const observation: ClaudeSessionObservation = { discovered: false, selected: false, skills: [], policyDigests: [], observedWorkerIds: [] };
  let outcome: EvidenceOutcome = { status: "blocked", reason: "No completed Claude Code result was observed." };
  let usage: Usage = { metering: "unknown", reason: "Claude Code did not report validated usage." };
  const redact = (text: string) => sensitiveValues.filter(Boolean).reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), text);
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = object(JSON.parse(line)); }
    catch { return { actions, observation, usage, outcome: { status: "blocked", reason: "Claude Code emitted malformed JSONL." } as const }; }

    if (event.type === "system" && event.subtype === "init") {
      observation.skills = array(event.skills).filter((name): name is string => typeof name === "string");
      observation.discovered = array(event.plugins).map(object).some(({ source }) => source === pluginId || source === "axiom@inline");
      observation.selected = observation.discovered;
      if (typeof event.claude_code_version === "string") observation.observedVersion = event.claude_code_version;
      if (typeof event.model === "string") observation.observedModel = event.model;
    } else if (event.type === "system" && event.subtype === "hook_response" && event.exit_code === 0 && event.outcome === "success") {
      const output = readHookContext(event.stdout);
      const context = output?.additionalContext;
      if (typeof context !== "string") continue;
      const [marker, digest] = /^Axiom policy digest: (sha256:[a-f0-9]{64})\n/.exec(context) ?? [];
      if (!marker || !digestSchema.safeParse(digest).success) continue;
      if (event.hook_event === "SessionStart" && output?.hookEventName === "SessionStart") observation.policyDigests.push(digest!);
      if (event.hook_event === "SubagentStart" && output?.hookEventName === "SubagentStart") {
        const brief = /\nAxiom scoped worker brief: (.+)$/.exec(context)?.[1];
        if (brief) {
          try {
            const parsed = taskBriefSchema.safeParse(JSON.parse(brief));
            if (parsed.success && parsed.data.parentId && parsed.data.policy.digest === digest) observation.observedWorkerIds!.push(parsed.data.id);
          } catch { /* A malformed worker observation remains unavailable. */ }
        }
      }
    } else if (event.type === "assistant") {
      for (const local of array(object(event.message).content).map(object)) {
        if (local.type !== "tool_use" || typeof local.id !== "string") continue;
        const input = object(local.input);
        if ((local.name === "Read" || local.name === "Write" || local.name === "Edit") && typeof input.file_path === "string") {
          pendingTools.set(local.id, { kind: local.name === "Read" ? "read" : "edit", path: redact(input.file_path) });
        }
        if (local.name === "Bash" && typeof input.command === "string") {
          pendingTools.set(local.id, { kind: "command", command: redact(input.command) });
        }
      }
    } else if (event.type === "user") {
      for (const local of array(object(event.message).content).map(object)) {
        if (local.type !== "tool_result" || typeof local.tool_use_id !== "string") continue;
        const action = pendingTools.get(local.tool_use_id);
        if (action && local.is_error !== true) actions.push(action);
        pendingTools.delete(local.tool_use_id);
      }
    } else if (event.type === "result") {
      const native = object(event.usage);
      const parsed = usageSchema.safeParse({
        metering: "reported", inputTokens: native.input_tokens, outputTokens: native.output_tokens,
        ...(typeof event.total_cost_usd === "number" ? { cost: { amount: event.total_cost_usd, currency: "USD" } } : {}),
      });
      if (parsed.success) usage = parsed.data;
      outcome = event.subtype === "success" && event.is_error === false
        ? { status: "passed" } : { status: "blocked", reason: "Claude Code returned an incomplete native result." };
    }
  }
  return { actions, observation, usage, outcome };
}
