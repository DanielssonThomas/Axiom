import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { digestSchema, evidenceSchema, policyIdentitySchema, taskBriefSchema, type Evidence, type EvidenceOutcome, type PolicyIdentity, type TaskBrief } from "@axiom/contracts";
import { isDeepStrictEqual } from "node:util";

export const workerBriefKey = "AXIOM_CLAUDE_WORKER_BRIEF";
export const runtimeFile = "axiom-runtime.json";
export const corePolicyPath = "core/AXIOMS.md";
export const workerIdentityMarker = "\n\nAxiom native worker identity: ";
export const workerBriefMarker = "\n\nAxiom scoped worker brief: ";

export function policyPaths(policy: PolicyIdentity): readonly string[] {
  return [corePolicyPath, ...policy.profiles.map(({ id }) => `profiles/${id}/PROFILE.md`)];
}

export interface RuntimeManifest {
  policy: PolicyIdentity;
  files: readonly { path: string; digest: string }[];
}

type HookEvent = "SessionStart" | "SubagentStart";
interface HookOutput {
  hookSpecificOutput: { hookEventName: HookEvent; additionalContext: string };
}
export interface ClaudeHookResult {
  exitCode: 0 | 2;
  evidence?: Evidence;
  output?: HookOutput;
  outcome: EvidenceOutcome;
}

export function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function pluginFile(plugin: string, path: string): Promise<Buffer> {
  if (!path || path.includes("\\") || path.split("/").some((part) => part === "" || part === ".." || part === ".")) {
    throw new Error("Malformed native runtime path.");
  }
  const local = join(plugin, path);
  const real = await realpath(local);
  const offset = relative(plugin, real);
  if (isAbsolute(offset) || offset.startsWith(`..${sep}`) || offset === ".." || !(await lstat(local)).isFile()) {
    throw new Error("Invalid native runtime file.");
  }
  return readFile(real);
}

export function parseWorkerBrief(raw: string | undefined): TaskBrief | undefined {
  if (!raw) return;
  try {
    const brief = taskBriefSchema.parse(JSON.parse(raw));
    if (brief.parentId) return brief;
  } catch { /* Invalid transport is a blocked worker requirement. */ }
}

export function workerBriefEnvironment(brief: TaskBrief) {
  const checked = taskBriefSchema.parse(brief);
  if (!checked.parentId) throw new Error("A native worker brief requires its parent task ID.");
  return { [workerBriefKey]: JSON.stringify(checked) };
}

/** Verify installed native content before returning any context to the parent or delegated worker. */
export async function runClaudeHook(
  root: string, raw: unknown, worker?: string, section = corePolicyPath,
): Promise<ClaudeHookResult> {
  const startedAt = new Date().toISOString();
  const clock = performance.now();
  const input = object(raw);
  const event = input.hook_event_name;
  if ((event !== "SessionStart" && event !== "SubagentStart") ||
      (event === "SessionStart" && input.source !== "startup")) {
    return { exitCode: 2, outcome: { status: "blocked", reason: "This Claude hook event is outside the declared surface." } };
  }
  try {
    const plugin = await realpath(root);
    const manifest = object(JSON.parse((await pluginFile(plugin, runtimeFile)).toString()));
    const policy = policyIdentitySchema.parse(manifest.policy);
    const files = array(manifest.files).map(object);
    const paths = policyPaths(policy);
    if (!paths.includes(section) || !paths.every((selected) => files.some(({ path }) => path === selected))) {
      throw new Error("No complete runtime policy inventory.");
    }
    const observed = await Promise.all(files.map(async ({ path, digest }) => {
      if (typeof path !== "string") throw new Error("Malformed native inventory.");
      const expected = digestSchema.parse(digest);
      const bytes = await pluginFile(plugin, path).catch(() => undefined);
      return { path, expected, digest: bytes && sha256(bytes), bytes };
    }));
    const brief = event === "SubagentStart" ? parseWorkerBrief(worker) : undefined;
    const workerTask = brief && isDeepStrictEqual(brief.policy, policy) ? brief : undefined;
    const agentId = event === "SubagentStart" && typeof input.agent_id === "string" ? input.agent_id.trim() : "";
    let outcome: EvidenceOutcome = { status: "passed" };
    if (observed.some((file) => file.digest !== file.expected)) {
      outcome = { status: "failed", reason: "The installed native bundle failed its integrity check." };
    } else if (event === "SubagentStart" && (!workerTask || !agentId)) {
      outcome = { status: "blocked", reason: "An applicable native worker brief or observed worker identity was missing." };
    }
    const policyText = observed.find(({ path }) => path === section)?.bytes?.toString();
    if (!policyText?.trim()) outcome = { status: "failed", reason: "The installed policy document is incomplete." };
    const context = `Axiom policy digest: ${policy.digest}\nAxiom policy section: ${section}\n\n${policyText ?? ""}`
      + (agentId ? workerIdentityMarker + JSON.stringify(agentId) : "")
      + (workerTask && section === corePolicyPath ? workerBriefMarker + JSON.stringify(workerTask) : "");
    const output: HookOutput = { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
    if (outcome.status === "passed" && JSON.stringify(output).length + 1 > 10_000) {
      outcome = { status: "blocked", reason: "Claude's context limit would truncate an installed policy section or task brief." };
    }
    const evidence = evidenceSchema.parse({
      id: randomUUID(), taskId: workerTask?.id ?? "claude-native-hook",
      ...(workerTask?.parentId ? { parentTaskId: workerTask.parentId } : {}),
      criterionIds: workerTask?.criteria.map(({ id }) => id) ?? ["native-payload"],
      policy, source: { digest: sha256(JSON.stringify(observed.map(({ path, digest }) => [path, digest ?? null]))) },
      provenance: "observed", startedAt, durationMs: performance.now() - clock, artifacts: [], outcome,
    });
    if (outcome.status !== "passed") return { exitCode: 2, evidence, outcome };
    return { exitCode: 0, evidence, outcome, output };
  } catch {
    return { exitCode: 2, outcome: { status: "blocked", reason: "The installed native bundle could not be validated." } };
  }
}
