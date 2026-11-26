import { evidenceOutcomeSchema, type EvidenceOutcome } from "@axiom/contracts";

export const transportRequirements = [
  "installation", "ordinarySession", "skillDiscovery", "update", "disabledControl", "uninstall", "settingsPreservation",
] as const;
export const behaviorRequirements = [
  "skillUse", "reuse", "clarification", "verificationReporting", "profileBehavior", "independentBenchmarks",
] as const;

type Outcomes<Requirement extends string> = Partial<Record<Requirement, unknown>>;
type TransportRequirement = typeof transportRequirements[number];
type BehaviorRequirement = typeof behaviorRequirements[number];

function outcome(value: unknown, reason: string): EvidenceOutcome {
  const parsed = evidenceOutcomeSchema.safeParse(value);
  return parsed.success ? parsed.data : { status: "not_run", reason };
}

function summarize(checks: readonly EvidenceOutcome[], unavailable: string): EvidenceOutcome {
  if (checks.some(({ status }) => status === "failed")) {
    return { status: "failed", reason: "A required installed-host check failed." };
  }
  return checks.every(({ status }) => status === "passed")
    ? { status: "passed" } : { status: "blocked", reason: unavailable };
}

/** A native CLI talking to a synthetic provider can establish transport and installation behavior only. */
export function assessInstalledHost(
  observations: Outcomes<TransportRequirement>,
) {
  const native = Object.fromEntries(transportRequirements.map((requirement) => [
    requirement, outcome(observations[requirement], "No native observation was supplied."),
  ])) as Record<TransportRequirement, EvidenceOutcome>;
  const behavior = Object.fromEntries(behaviorRequirements.map((requirement) => [
    requirement, { status: "not_run", reason: "An authorized real-model run and independent grading were not available." },
  ])) as Record<BehaviorRequirement, EvidenceOutcome>;
  const checks = { ...native, ...behavior };
  return {
    checks,
    transport: summarize(Object.values(native), "Required native transport evidence is incomplete."),
    outcome: summarize(Object.values(checks), "Required installed-host qualification is incomplete."),
  };
}
