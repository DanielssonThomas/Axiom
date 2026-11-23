import { evidenceOutcomeSchema } from "@axiom/contracts";
import type { EvidenceOutcome } from "@axiom/contracts";
import type { CheckObservation, EffectiveRequirement, PolicyAssessment, PolicyResolution } from "./model.js";

function checkOutcome(requirement: EffectiveRequirement, observations: readonly CheckObservation[]): EvidenceOutcome {
  const [observed] = observations;
  if (!observed) return { status: "not_run", reason: "No observed result." };
  if (observations.length !== 1) return { status: "failed", reason: "Multiple results were supplied for this check." };
  if (observed.kind !== requirement.kind) return { status: "failed", reason: `Expected a ${requirement.kind} result.` };
  const result = evidenceOutcomeSchema.safeParse(observed.outcome);
  return result.success ? result.data : { status: "failed", reason: "Invalid evidence outcome." };
}

/** Assess declared checks using the caller's observed results for the relevant source state. */
export function assessPolicy(resolution: PolicyResolution, observations: readonly CheckObservation[]): PolicyAssessment {
  const byId = new Map<string, CheckObservation[]>();
  for (const observation of observations) {
    const matches = byId.get(observation.id) ?? [];
    matches.push(observation);
    byId.set(observation.id, matches);
  }
  const checks = (resolution.policy?.requirements ?? []).map((requirement) => ({
    ...requirement,
    outcome: checkOutcome(requirement, byId.get(requirement.id) ?? []),
  }));
  const result = (outcome: EvidenceOutcome): PolicyAssessment => ({ outcome, checks });
  if (resolution.diagnostics.some(({ code }) => code !== "instruction_conflict" && code !== "incompatible_requirement")) {
    return result({ status: "failed", reason: "Invalid policy definitions or references." });
  }

  const required = checks.filter((check) => check.required);
  for (const { id, outcome } of required) {
    if (outcome.status === "failed" || outcome.status === "not_applicable") {
      return result({ status: "failed", reason: `Required check ${id} is ${outcome.status}: ${outcome.reason}` });
    }
  }
  if (resolution.diagnostics.length > 0) {
    return result({ status: "blocked", reason: "Policy conflicts prevent a conformance result." });
  }
  const blocked = required.find(({ outcome }) => outcome.status === "blocked");
  if (blocked) return result({ status: "blocked", reason: `Required check ${blocked.id} is blocked.` });
  const missing = required.find(({ outcome }) => outcome.status === "not_run");
  if (missing) return result({ status: "not_run", reason: `Required check ${missing.id} has not run.` });
  if (required.length === 0) return result({ status: "not_run", reason: "No required checks were registered." });

  return result({ status: "passed" });
}
