import { realpath, stat } from "node:fs/promises";
import { criterionSchema, taskBriefSchema } from "@axiom/contracts";
import { resolutionReason, resolveInvocation } from "./commands.js";
import type { CommandAuthority, PlannedCheck, VerificationPlan, VerificationPlanRequest } from "./model.js";

/** Resolve caller-mapped criteria against explicitly authoritative repository sources. */
export async function planVerification(request: VerificationPlanRequest): Promise<VerificationPlan> {
  const root = await realpath(request.root);
  if (!(await stat(root)).isDirectory()) throw new Error("The repository root must be a directory.");
  const task = taskBriefSchema.parse(request.task);
  const requiredById = new Map(task.criteria.map((criterion) => [criterion.id, criterion.required]));
  if (requiredById.size !== task.criteria.length) throw new Error("Task criterion identifiers must be unique.");
  const requirements = structuredClone(request.requirements);
  const ids = new Set<string>();
  const checks: PlannedCheck[] = [];
  for (const requirement of requirements) {
    const id = criterionSchema.shape.id.parse(requirement.id);
    if (ids.has(id)) throw new Error("Verification check identifiers must be unique.");
    ids.add(id);
    const required = requiredById.get(requirement.criterionId);
    if (required === undefined) throw new Error("A verification requirement refers to an unknown criterion.");
    if (requirement.kind !== "automated" && requirement.kind !== "runtime" && requirement.kind !== "visual") {
      throw new Error("Unknown verification kind.");
    }
    const sources: CommandAuthority[] = [];
    const timeoutMs = Math.min(task.limits.timeoutMs, requirement.timeoutMs ?? task.limits.timeoutMs);
    const metadata = { id, criterionId: requirement.criterionId, kind: requirement.kind, required, sources, timeoutMs };
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      checks.push({ ...metadata, outcome: { status: "blocked", reason: "The command requires a valid bounded execution time." } });
    } else if (!requirement.command) {
      checks.push({ ...metadata, outcome: { status: "not_run", reason: "No repository command was mapped to this requirement." } });
    } else {
      try {
        checks.push({ ...metadata, invocation: await resolveInvocation(root, requirement.kind, requirement.command, sources) });
      } catch (error) {
        checks.push({ ...metadata, outcome: { status: "blocked", reason: resolutionReason(error) } });
      }
    }
  }
  for (const criterion of task.criteria) {
    if (checks.some((check) => check.criterionId === criterion.id)) continue;
    checks.push({
      id: `unmapped.${criterion.id}`, criterionId: criterion.id, required: criterion.required, kind: "automated",
      sources: [], timeoutMs: task.limits.timeoutMs,
      outcome: { status: "not_run", reason: "No verification requirement was mapped to this criterion." },
    });
  }
  return { root, task, requirements, checks };
}
