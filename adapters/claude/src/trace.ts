import { isDeepStrictEqual } from "node:util";
import { capabilitySchema, digestSchema, usageSchema, type Capability, type EvidenceOutcome, type HostIdentity, type PolicyIdentity, type Usage } from "@axiom/contracts";
import { pluginId, supportedVersion, type ClaudeBundle } from "./bundle.js";
import { withheldAnswer, type WithheldQuestion } from "./clarification.js";
import { array, corePolicyPath, object, parseWorkerBrief, policyPaths, sha256, workerBriefMarker, workerIdentityMarker } from "./runtime.js";

type Action = { kind: "read" | "edit"; path: string } | { kind: "command"; command: string }
  | { kind: "ask"; topic: string };
type HookFailure = EvidenceOutcome & { status: "failed" | "blocked" };
interface PolicySection { policyDigest: string; path: string; digest: string }
interface ObservedWorker {
  agentId: string;
  sections: PolicySection[];
  briefs: { taskId: string; policy: PolicyIdentity; matchesStagedBrief: boolean }[];
}

export interface ClaudeSessionObservation {
  discovered: boolean;
  selected: boolean;
  observedVersion?: string;
  observedModel?: string;
  skills: string[];
  policyDigests: string[];
  policySections: PolicySection[];
  startupFailure?: HookFailure;
  workerFailure?: HookFailure;
  workers: ObservedWorker[];
}

export function supportedClaudeHost(host: HostIdentity) {
  return host.agent === "claude" && host.os === "linux" && host.version === supportedVersion && host.surface === "cli";
}

function hasPolicySections(bundle: ClaudeBundle, sections: readonly PolicySection[]) {
  return policyPaths(bundle.manifest.policy).every((path) => {
    const expected = bundle.manifest.files.find((file) => file.path === bundle.manifest.runtimeRoot + path);
    return expected !== undefined && sections.some((section) =>
      section.path === path && section.policyDigest === bundle.manifest.policy.digest && section.digest === expected.digest);
  });
}

export function claudeCapabilities(host: HostIdentity, observation?: ClaudeSessionObservation, bundle?: ClaudeBundle): Capability[] {
  const native = supportedClaudeHost(host);
  const worker = observation?.workers.length === 1 ? observation.workers[0] : undefined;
  const brief = worker?.briefs.length === 1 ? worker.briefs[0] : undefined;
  const delegation = native && observation?.observedVersion === host.version && observation.observedModel === host.model
    && !observation.workerFailure && bundle && worker && brief?.matchesStagedBrief
    && isDeepStrictEqual(brief.policy, bundle.manifest.policy)
    && worker.sections.length === policyPaths(bundle.manifest.policy).length && hasPolicySections(bundle, worker.sections);
  return [
    ...["native-package", "startup", "process-execution", "action-trace"].map((id) => capabilitySchema.parse(native
      ? { id, available: true } : { id, available: false, reason: "Unsupported Claude Code surface, version, or platform." })),
    ...["resume", "compaction", "hook-enforcement"].map((id): Capability => ({
      id, available: false, reason: `Observable ${id} coverage is unavailable on the declared Claude CLI surface.`,
    })),
    delegation ? { id: "delegation", available: true } : {
      id: "delegation", available: false,
      reason: observation?.workerFailure?.reason ?? "No single native worker received the complete requested policy and staged brief.",
    },
  ];
}

export function assessClaudeActivation(
  bundle: ClaudeBundle, host: HostIdentity, observation: ClaudeSessionObservation, required: readonly string[] = [],
) {
  const loading = hasPolicySections(bundle, observation.policySections)
    && bundle.manifest.skills.every(({ id }) => observation.skills.includes(`axiom:${id}`));
  const capabilities = claudeCapabilities(host, observation, bundle);
  const missing = required.find((id) => !capabilities.some((capability) => capability.id === id && capability.available));
  let outcome: EvidenceOutcome = { status: "passed" };
  if (!supportedClaudeHost(host) || observation.observedVersion !== host.version || observation.observedModel !== host.model) {
    outcome = { status: "blocked", reason: "The observed Claude Code surface, model, or version did not match." };
  } else if (observation.startupFailure) {
    outcome = observation.startupFailure;
  } else if (!observation.discovered || !observation.selected || !loading) {
    outcome = { status: "blocked", reason: "Claude plugin discovery, selection, or context loading was not observed." };
  } else if (required.includes("delegation") && observation.workerFailure) {
    outcome = observation.workerFailure;
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

export function parseClaudeTrace(raw: string, sensitiveValues: readonly string[] = [], stagedWorkerBrief?: string,
  withheldQuestions?: ReadonlyMap<string, WithheldQuestion>) {
  const actions: Action[] = [];
  const pendingTools = new Map<string, Action>();
  const questionTools = new Set<string>();
  const pendingQuestions = new Map<string, Action>();
  const confirmedQuestions = new Set<Action>();
  const observedActions = () => actions.filter((action) => action.kind !== "ask" || confirmedQuestions.has(action));
  const observation: ClaudeSessionObservation = {
    discovered: false, selected: false, skills: [], policyDigests: [], policySections: [], workers: [],
  };
  const expectedWorker = parseWorkerBrief(stagedWorkerBrief);
  const workers = new Map<string, ObservedWorker>();
  let outcome: EvidenceOutcome = { status: "blocked", reason: "No completed Claude Code result was observed." };
  let usage: Usage = { metering: "unknown", reason: "Claude Code did not report validated usage." };
  const redact = (text: string) => sensitiveValues.filter(Boolean).reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), text);
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = object(JSON.parse(line)); }
    catch { return { actions: observedActions(), observation, usage, outcome: { status: "blocked", reason: "Claude Code emitted malformed JSONL." } as const }; }

    if (event.type === "system" && event.subtype === "init") {
      observation.skills = array(event.skills).filter((name): name is string => typeof name === "string");
      observation.discovered = array(event.plugins).map(object).some(({ source }) => source === pluginId || source === "axiom@inline");
      observation.selected = observation.discovered;
      if (typeof event.claude_code_version === "string") observation.observedVersion = event.claude_code_version;
      if (typeof event.model === "string") observation.observedModel = event.model;
    } else if (event.type === "system" && event.subtype === "hook_response") {
      if (event.exit_code !== 0 || event.outcome !== "success") {
        const stage = event.hook_event === "SessionStart" ? "startupFailure"
          : event.hook_event === "SubagentStart" ? "workerFailure" : undefined;
        if (stage && typeof event.stderr === "string") {
          const [, status, reason] = /^Axiom native hook (failed|blocked): ([^\r\n]+)/.exec(event.stderr) ?? [];
          if ((status === "failed" || status === "blocked") && reason && observation[stage]?.status !== "failed") {
            observation[stage] = { status, reason: redact(reason) };
          }
        }
        continue;
      }
      const output = readHookContext(event.stdout);
      const context = output?.additionalContext;
      if (typeof context !== "string") continue;
      const [header, digest, path] = /^Axiom policy digest: (sha256:[a-f0-9]{64})\nAxiom policy section: ([^\r\n]+)\n\n/.exec(context) ?? [];
      if (!header || !digest || !path || !digestSchema.safeParse(digest).success) continue;
      if (event.hook_event === "SessionStart" && output?.hookEventName === "SessionStart") {
        if (!observation.policyDigests.includes(digest)) observation.policyDigests.push(digest);
        observation.policySections.push({ policyDigest: digest, path, digest: sha256(context.slice(header.length)) });
      }
      if (event.hook_event === "SubagentStart" && output?.hookEventName === "SubagentStart") {
        const identityStart = context.lastIndexOf(workerIdentityMarker);
        if (identityStart < header.length) continue;
        const briefStart = context.indexOf(workerBriefMarker, identityStart + workerIdentityMarker.length);
        let agentId: unknown;
        try {
          agentId = JSON.parse(context.slice(identityStart + workerIdentityMarker.length, briefStart < 0 ? undefined : briefStart));
        } catch { continue; }
        if (typeof agentId !== "string" || !agentId.trim()) continue;
        let worker = workers.get(agentId);
        if (!worker) {
          worker = { agentId, sections: [], briefs: [] };
          workers.set(agentId, worker);
          observation.workers.push(worker);
        }
        worker.sections.push({ policyDigest: digest, path, digest: sha256(context.slice(header.length, identityStart)) });
        const brief = path === corePolicyPath && briefStart >= 0
          ? parseWorkerBrief(context.slice(briefStart + workerBriefMarker.length)) : undefined;
        if (brief) {
          worker.briefs.push({ taskId: brief.id, policy: brief.policy, matchesStagedBrief: isDeepStrictEqual(brief, expectedWorker) });
        }
      }
    } else if (event.type === "assistant") {
      for (const local of array(object(event.message).content).map(object)) {
        if (local.type !== "tool_use" || typeof local.id !== "string") continue;
        const input = object(local.input);
        if (local.name === "AskUserQuestion") questionTools.add(local.id);
        if ((local.name === "Read" || local.name === "Write" || local.name === "Edit") && typeof input.file_path === "string") {
          pendingTools.set(local.id, { kind: local.name === "Read" ? "read" : "edit", path: redact(input.file_path) });
        }
        if (local.name === "Bash" && typeof input.command === "string") {
          pendingTools.set(local.id, { kind: "command", command: redact(input.command) });
        }
      }
    } else if (event.type === "control_request" && typeof event.request_id === "string") {
      const question = withheldQuestions?.get(event.request_id);
      if (question && questionTools.delete(question.toolUseId)) {
        const action: Action = { kind: "ask", topic: question.topic };
        pendingQuestions.set(question.toolUseId, action);
        actions.push(action);
      }
    } else if (event.type === "user") {
      for (const local of array(object(event.message).content).map(object)) {
        if (local.type !== "tool_result" || typeof local.tool_use_id !== "string") continue;
        const action = pendingTools.get(local.tool_use_id);
        if (action && local.is_error !== true) actions.push(action);
        pendingTools.delete(local.tool_use_id);
        const ask = pendingQuestions.get(local.tool_use_id);
        if (ask && local.is_error === true && local.content === withheldAnswer && array(event.tool_result_meta).map(object).some((meta) => {
          const permission = object(meta.permission_decision);
          return meta.id === local.tool_use_id && permission.decision === "reject" && permission.source === "user_reject";
        })) confirmedQuestions.add(ask);
        pendingQuestions.delete(local.tool_use_id);
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
  return { actions: observedActions(), observation, usage, outcome };
}
