import { isDeepStrictEqual } from "node:util";
import { taskBriefSchema, type EvidenceOutcome, type TaskBrief } from "@axiom/contracts";
import { observedPolicyFragments, type CodexBundle } from "./bundle.js";
import { array, object } from "./process.js";

export interface CodexProviderObservation {
  /** Values captured by an independent observer of the provider request. */
  readonly turnMetadata: unknown;
  readonly body: unknown;
}

export interface CodexDelegationEvidence {
  readonly brief: TaskBrief;
  readonly trace: string;
  readonly requests: readonly CodexProviderObservation[];
}

export interface CodexDelegationObservation {
  outcome: EvidenceOutcome;
  parentThreadId?: string;
  workerThreadId?: string;
}

export function formatCodexWorkerBrief(brief: TaskBrief): string {
  const validated = taskBriefSchema.parse(brief);
  if (!validated.parentId) throw new Error("An Axiom worker brief needs a parent task ID.");
  return `${validated.objective}\n\nAxiom scoped worker brief:\n${JSON.stringify(validated)}`;
}

function decodeMetadata(value: unknown) {
  if (typeof value !== "string") return {};
  try { return object(JSON.parse(value)); } catch { return {}; }
}

/** Check one fresh spawn against its independently observed first model request. */
export function observeCodexDelegation(
  bundle: CodexBundle, model: string, evidence: CodexDelegationEvidence,
): CodexDelegationObservation {
  const blocked = (reason: string): CodexDelegationObservation => ({ outcome: { status: "blocked", reason } });
  const brief = taskBriefSchema.safeParse(evidence.brief);
  if (!brief.success || !brief.data.parentId || !isDeepStrictEqual(brief.data.policy, bundle.policy)) {
    return blocked("The staged Codex worker brief does not bind the selected Axiom policy and parent.");
  }
  let events: Record<string, unknown>[];
  try { events = evidence.trace.split("\n").filter((line) => line.trim()).map((line) => object(JSON.parse(line))); }
  catch { return blocked("The native Codex transcript could not be read."); }
  const starts = events.filter(({ type }) => type === "thread.started");
  const parentThreadId = starts[0]?.thread_id;
  const spawned = events.filter(({ type }) => type === "item.completed").map(({ item }) => object(item))
    .filter(({ type, tool }) => type === "collab_tool_call" && tool === "spawn_agent");
  const spawn = spawned[0];
  const workers = array(spawn?.receiver_thread_ids);
  const workerThreadId = workers[0];
  if (starts.length !== 1 || typeof parentThreadId !== "string" || !parentThreadId ||
    spawned.length !== 1 || spawn?.status !== "completed" || spawn.sender_thread_id !== parentThreadId ||
    workers.length !== 1 || typeof workerThreadId !== "string" || !workerThreadId || workerThreadId === parentThreadId ||
    !events.some(({ type }) => type === "turn.completed") || events.some(({ type }) => type === "turn.failed")) {
    return blocked("A completed single-worker Codex spawn could not be independently identified.");
  }
  const request = evidence.requests.map(({ turnMetadata, body }) => ({ metadata: decodeMetadata(turnMetadata), body: object(body) }))
    .find(({ metadata }) => metadata.thread_id === workerThreadId && metadata.request_kind === "turn");
  if (!request || request.metadata.parent_thread_id !== parentThreadId || request.metadata.session_id !== parentThreadId ||
    request.metadata.thread_source !== "subagent" || request.metadata.subagent_kind !== "thread_spawn" ||
    request.metadata.history_initialization !== "new" || request.metadata.model !== model || request.body.model !== model) {
    return blocked("The worker's first Codex provider request could not be matched to the native spawn.");
  }
  const messages = array(request.body.input).map(object).filter(({ type, role }) => type === "message" && role === "user");
  const policy = messages.slice(0, -1).flatMap(({ content }) => array(content).map(object)).some(({ type, text }) =>
    type === "input_text" && typeof text === "string" && text.startsWith("# AGENTS.md instructions for ") &&
    observedPolicyFragments(text).includes(bundle.instructions));
  const task = array(messages.at(-1)?.content).map(object);
  const complete = policy && task.length === 1 && task[0]?.type === "input_text" && task[0].text === formatCodexWorkerBrief(brief.data);
  return {
    parentThreadId, workerThreadId,
    outcome: complete ? { status: "passed" } : {
      status: "failed", reason: "The first observed Codex worker request omitted the complete selected policy or staged task brief.",
    },
  };
}
