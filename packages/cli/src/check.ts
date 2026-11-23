import { isAbsolute } from "node:path";
import { capabilitySchema, hostIdentitySchema, taskBriefSchema, type EvidenceOutcome } from "@axiom/contracts";
import { EvidenceStore } from "@axiom/evidence";
import { executeVerification, planVerification, type VerificationPlanRequest, type VerificationReport } from "@axiom/verification";

function blocked(reason: string): { outcome: EvidenceOutcome } {
  return { outcome: { status: "blocked", reason } };
}

export async function runCheck(request: unknown): Promise<{ outcome: EvidenceOutcome; report?: VerificationReport }> {
  if (request === undefined) {
    return { outcome: { status: "not_run", reason: "A trusted verification request is required." } };
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return blocked("The verification request must be an object.");
  }
  const { root, evidenceDirectory, requirements, task, capabilities, host } = request as Record<string, unknown>;
  if (typeof root !== "string" || !isAbsolute(root) ||
      typeof evidenceDirectory !== "string" || !isAbsolute(evidenceDirectory) || !Array.isArray(requirements)) {
    return blocked("The verification request requires absolute source and evidence paths and a requirements array.");
  }
  const brief = taskBriefSchema.safeParse(task);
  if (!brief.success || !brief.data.criteria.some(({ required }) => required)) {
    return blocked("A valid task with at least one required criterion is needed.");
  }
  const available = capabilitySchema.array().optional().safeParse(capabilities);
  const identity = hostIdentitySchema.optional().safeParse(host);
  if (!available.success || !identity.success) return blocked("The verification host or capabilities could not be validated.");
  const declared = available.data ?? [];
  if (new Set(declared.map(({ id }) => id)).size !== declared.length) {
    return blocked("Verification capability identifiers must be unique.");
  }
  const missing = brief.data.requiredCapabilities.find((id) =>
    !declared.some((capability) => capability.id === id && capability.available));
  if (missing) return blocked(`A required verification capability is unavailable: ${missing}.`);

  try {
    const plan = await planVerification({
      root, task: brief.data, requirements: requirements as VerificationPlanRequest["requirements"],
    });
    const { report } = await executeVerification({
      plan, store: new EvidenceStore(evidenceDirectory), capabilities: declared,
      ...(identity.data === undefined ? {} : { host: identity.data }),
    });
    if (report.conforms) return { outcome: { status: "passed" }, report };
    const required = report.checks.filter((check) => check.required);
    for (const status of ["failed", "blocked", "not_run"] as const) {
      const result = required.find(({ outcome }) => outcome.status === status);
      if (result) return { outcome: result.outcome, report };
    }
    return { ...blocked("Required verification evidence is incomplete."), report };
  } catch {
    return blocked("The verification request could not be planned or assessed.");
  }
}
