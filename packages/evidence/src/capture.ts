import { evidenceSchema, type CommandEvidence, type Evidence, type EvidenceOutcome, type HostIdentity, type TaskBrief } from "@axiom/contracts";
import { excludeArchive, snapshotSource, type SourceScope } from "./source.js";
import type { EvidenceStore, SelectedArtifact } from "./store.js";

export type CommandCompletion =
  | { kind: "exited"; exitCode: number }
  | { kind: "unavailable"; reason: "executable" | "cwd" | "startup" }
  | { kind: "interrupted"; reason: "signal" | "cancelled" | "timed_out"; signal?: string };

export type CommandInvocation = Pick<CommandEvidence, "executable" | "args" | "cwd">;

export interface CommandEvidenceRequest {
  id: string;
  task: Pick<TaskBrief, "id" | "parentId" | "policy">;
  criterionIds: Evidence["criterionIds"];
  host?: HostIdentity;
  source: SourceScope;
  command: CommandInvocation;
  store: EvidenceStore;
  artifacts?: readonly SelectedArtifact[];
  /** Values to redact from recorded command metadata before it can be persisted. */
  sensitiveValues?: readonly string[];
}

const unavailableReasons = {
  executable: "The command executable is unavailable.",
  cwd: "The command working directory is unavailable.",
  startup: "The command could not be started.",
};
const interruptedReasons = {
  signal: "The command was interrupted by a termination signal.",
  cancelled: "The command was interrupted by cancellation.",
  timed_out: "The command was interrupted after reaching its time limit.",
};

function outcomeOf(completion: CommandCompletion): EvidenceOutcome {
  switch (completion.kind) {
    case "unavailable": return { status: "blocked", reason: unavailableReasons[completion.reason] };
    case "interrupted": return { status: "blocked", reason: interruptedReasons[completion.reason] };
    case "exited": return completion.exitCode === 0
      ? { status: "passed" }
      : { status: "failed", reason: `The command exited with code ${completion.exitCode}.` };
  }
}

function recordableCommand(command: CommandInvocation, values: readonly string[]): CommandEvidence {
  const secrets = [...new Set(values.filter(Boolean))].sort((left, right) => right.length - left.length);
  if (secrets.length === 0) return { executable: command.executable, args: [...command.args], cwd: command.cwd };
  const escaped = secrets.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(escaped.join("|"), "g");
  const redact = (value: string) => value.replace(pattern, "[REDACTED]");
  return { executable: redact(command.executable), args: command.args.map(redact), cwd: redact(command.cwd) };
}

/** Observe a command executed by the caller, with source and output identities bound to the result. */
export async function captureCommandEvidence(
  request: CommandEvidenceRequest,
  execute: (invocation: CommandInvocation) => Promise<CommandCompletion>,
): Promise<Evidence> {
  const scope = excludeArchive(request.source, request.store.directory);
  const source = await snapshotSource(scope);
  const invocation = {
    executable: request.command.executable,
    args: [...request.command.args],
    cwd: request.command.cwd,
  };
  const command = recordableCommand(invocation, request.sensitiveValues ?? []);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const completion = await execute(invocation);
  const durationMs = performance.now() - start;

  if (completion.kind === "exited") command.exitCode = completion.exitCode;
  if (completion.kind === "interrupted" && completion.signal) command.signal = completion.signal;

  const artifacts: Evidence["artifacts"] = [];
  let outcome = outcomeOf(completion);
  for (const selection of request.artifacts ?? []) {
    const artifact = await request.store.artifact(selection).catch(() => undefined);
    if (artifact) artifacts.push(artifact);
    else if (outcome.status === "passed") outcome = { status: "blocked", reason: "A selected artifact is missing or unreadable." };
  }

  if (outcome.status === "passed") {
    const finalSource = await snapshotSource(scope).catch(() => undefined);
    if (!finalSource) outcome = { status: "blocked", reason: "The final source identity is unavailable." };
    else if (source.digest !== finalSource.digest) outcome = { status: "blocked", reason: "The source changed during command execution." };
  }

  return evidenceSchema.parse({
    id: request.id,
    taskId: request.task.id,
    ...(request.task.parentId === undefined ? {} : { parentTaskId: request.task.parentId }),
    criterionIds: request.criterionIds,
    policy: request.task.policy,
    ...(request.host === undefined ? {} : { host: request.host }),
    source,
    provenance: "observed",
    startedAt,
    durationMs,
    command,
    artifacts,
    outcome,
  });
}
