import { isDeepStrictEqual } from "node:util";
import { evidenceSchema } from "@axiom/contracts";
import type { Evidence, EvidenceOutcome, PolicyIdentity, ResultStatus, SourceIdentity } from "@axiom/contracts";

export type GradingAction =
  | { readonly kind: "read" | "edit"; readonly path: string }
  | { readonly kind: "ask"; readonly topic: string }
  | { readonly kind: "delegate"; readonly brief: unknown }
  | { readonly kind: "worker-result"; readonly taskId: string }
  | {
    readonly kind: "check";
    readonly evidence: unknown;
    readonly tests?: readonly { readonly id: string; readonly status: ResultStatus }[];
  };

/** The verifier supplies snapshots and normalized tool observations. An absent trace means capture was unavailable. */
export interface GradingObservation {
  readonly before: ReadonlyMap<string, string>;
  readonly after: ReadonlyMap<string, string>;
  /** Relevant source and capability inputs, with emitted result files excluded. */
  readonly source: SourceIdentity;
  readonly policy: PolicyIdentity;
  readonly actions?: readonly GradingAction[];
}

export const passed = { status: "passed" } as const;
export const failed = (reason: string): EvidenceOutcome => ({ status: "failed", reason });
export const blocked = (reason: string): EvidenceOutcome => ({ status: "blocked", reason });

export function changedPaths({ before, after }: GradingObservation): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

export function isUnchanged({ before, after }: GradingObservation, path: string): boolean {
  return before.has(path) && before.get(path) === after.get(path);
}

export function observedCheck(
  action: GradingAction,
  observation: GradingObservation,
  criterionId: string,
): Evidence | undefined {
  if (action.kind !== "check") return;
  const parsed = evidenceSchema.safeParse(action.evidence);
  if (parsed.success && parsed.data.provenance === "observed"
    && parsed.data.criterionIds.includes(criterionId)
    && isDeepStrictEqual(parsed.data.policy, observation.policy)) {
    return parsed.data;
  }
}

export function observedNativeTest(
  action: GradingAction,
  observation: GradingObservation,
  criterionId: string,
  tests: Record<string, "passed" | "failed">,
): Evidence | undefined {
  if (action.kind !== "check") return;
  const evidence = observedCheck(action, observation, criterionId);
  const command = evidence?.command;
  if (!command || command.executable !== "node" || !isDeepStrictEqual(command.args, ["--test"])
    || !evidence.artifacts.some(({ kind }) => kind === "test-report")) {
    return;
  }
  if (Object.entries(tests).every(([id, status]) =>
    action.tests?.some((result) => result.id === id && result.status === status)
  )) {
    return evidence;
  }
}
