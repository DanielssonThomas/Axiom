import type { EvidenceOutcome, TaskBrief } from "@axiom/contracts";
import type { CommandInvocation } from "@axiom/evidence";

export type VerificationKind = "automated" | "runtime" | "visual";

export interface DocumentCommand {
  path: string;
  heading: string;
  /** Zero-based selection when the heading contains several command lines. */
  commandIndex?: number;
}

export interface CommandSource {
  cwd?: string;
  script?: { name: string; args?: readonly string[] };
  docs?: readonly DocumentCommand[];
}

export interface VerificationRequirement {
  id: string;
  criterionId: string;
  kind: VerificationKind;
  command?: CommandSource;
  timeoutMs?: number;
}

export interface CommandAuthority {
  path: string;
  digest: string;
  heading?: string;
}

interface CheckMetadata {
  id: string;
  criterionId: string;
  kind: VerificationKind;
  required: boolean;
  timeoutMs: number;
  sources: CommandAuthority[];
}

export type PlannedCheck = CheckMetadata & (
  | { invocation: CommandInvocation; outcome?: never }
  | { invocation?: never; outcome: EvidenceOutcome }
);

export interface VerificationPlanRequest {
  root: string;
  task: TaskBrief;
  requirements: readonly VerificationRequirement[];
}

export interface VerificationPlan extends VerificationPlanRequest {
  checks: PlannedCheck[];
}

export interface VerificationCheckResult {
  id: string;
  criterionId: string;
  kind: VerificationKind;
  required: boolean;
  evidenceId?: string;
  outcome: EvidenceOutcome;
}

export interface VerificationReport {
  conforms: boolean;
  checks: VerificationCheckResult[];
}
