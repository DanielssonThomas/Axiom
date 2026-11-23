import { evidenceSchema } from "@axiom/contracts";
import type { Criterion, Evidence, EvidenceOutcome, PolicyIdentity, SourceIdentity } from "@axiom/contracts";

const levels = ["atom", "molecule", "organism", "template"] as const;

export interface CompositionComponent {
  readonly id: string;
  readonly level: (typeof levels)[number];
  readonly owner: string;
  readonly visibility: "owner" | "public";
  readonly dependencies: readonly string[];
}

export type CompositionIssue =
  | { code: "duplicate-component"; component: string }
  | {
    code: "non-downward-dependency" | "private-dependency" | "missing-dependency";
    component: string;
    dependency: string;
  }
  | { code: "cycle"; path: string[] };

export function inspectComposition(components: readonly CompositionComponent[]): CompositionIssue[] {
  const issues: CompositionIssue[] = [];
  const byId = new Map<string, CompositionComponent>();
  for (const component of components) {
    if (byId.has(component.id)) {
      issues.push({ code: "duplicate-component", component: component.id });
    } else {
      byId.set(component.id, component);
    }
  }

  for (const component of byId.values()) {
    for (const dependency of component.dependencies) {
      const target = byId.get(dependency);
      if (!target) {
        issues.push({ code: "missing-dependency", component: component.id, dependency });
        continue;
      }
      if (levels.indexOf(target.level) >= levels.indexOf(component.level)) {
        issues.push({ code: "non-downward-dependency", component: component.id, dependency });
      }
      if (target.owner !== component.owner && target.visibility !== "public") {
        issues.push({ code: "private-dependency", component: component.id, dependency });
      }
    }
  }

  const complete = new Set<string>();
  const active = new Map<string, number>();
  const path: string[] = [];

  function visit(id: string): void {
    const component = byId.get(id);
    if (!component || complete.has(id)) return;

    const cycleStart = active.get(id);
    if (cycleStart !== undefined) {
      issues.push({ code: "cycle", path: [...path.slice(cycleStart), id] });
      return;
    }

    active.set(id, path.length);
    path.push(id);
    for (const dependency of component.dependencies) visit(dependency);
    path.pop();
    active.delete(id);
    complete.add(id);
  }

  for (const id of byId.keys()) visit(id);
  return issues;
}

export interface ReuseExpectation {
  readonly consumer: string;
  readonly compatibleComponents: readonly string[];
}

/** The fixture baseline or an independent reviewer supplies compatibility. */
export function inspectDesignSystemReuse(
  components: readonly CompositionComponent[],
  expectation: ReuseExpectation,
): EvidenceOutcome {
  const { consumer, compatibleComponents } = expectation;
  if (compatibleComponents.length === 0) {
    return { status: "not_applicable", reason: "No independently identified compatible component for this reuse assertion." };
  }

  const usage = components.find((component) => component.id === consumer);
  const reused = compatibleComponents.some((id) =>
    usage?.dependencies.includes(id) && components.some((component) => component.id === id)
  );
  if (reused) return { status: "passed" };

  return { status: "failed", reason: `${consumer} must use a compatible component: ${compatibleComponents.join(", ")}.` };
}

type UiVerificationMethod = "acceptance" | "live";

export interface UiCheck {
  readonly area: "layout" | "interaction" | "responsive" | "accessibility";
  readonly method: UiVerificationMethod;
  readonly criterion: Criterion;
}

export interface UiObservation {
  readonly method: UiVerificationMethod;
  readonly evidence: Evidence;
}

export function inspectUiVerification(
  check: UiCheck,
  candidate: UiObservation | undefined,
  current: { readonly source: SourceIdentity; readonly policy: PolicyIdentity },
): EvidenceOutcome {
  const label = `${check.method} ${check.area} check`;
  if (!candidate || candidate.method !== check.method) {
    return { status: "not_run", reason: `No matching evidence for the ${label}.` };
  }

  const parsed = evidenceSchema.safeParse(candidate.evidence);
  if (!parsed.success) {
    return { status: "blocked", reason: `The ${label} has an invalid evidence record.` };
  }

  const { data: evidence } = parsed;
  if (!evidence.criterionIds.includes(check.criterion.id)) {
    return { status: "not_run", reason: `No matching evidence for the ${label}.` };
  }
  if (evidence.source.digest !== current.source.digest || evidence.policy.digest !== current.policy.digest) {
    return { status: "blocked", reason: `The ${label} evidence is stale for the current source or policy.` };
  }

  const { outcome } = evidence;
  if (check.criterion.required && outcome.status === "not_applicable") {
    return { status: "blocked", reason: `The ${label} is required. Recorded reason: ${outcome.reason}` };
  }
  if (outcome.status !== "passed") return outcome;

  if (evidence.artifacts.length === 0) {
    return { status: "blocked", reason: `The ${label} is missing an observed result artifact.` };
  }
  if (check.method === "live" && !evidence.artifacts.some(({ kind }) => kind === "ui-observation" || kind === "browser-trace")) {
    return { status: "blocked", reason: `The ${label} needs a browser trace or a live UI observation.` };
  }
  return outcome;
}
