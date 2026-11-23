import type {
  EvidenceOutcome,
  PolicyIdentity,
  PrincipleDefinition,
  PrincipleId,
  ProfileDefinition,
  ProfileId,
} from "@axiom/contracts";

export interface PolicySource {
  path: string;
  text: string;
}

export type CheckKind = "mechanical" | "behavioral";

export interface CheckRegistration {
  kind: CheckKind;
  /** A registration tied to the core is mandatory in every profile. */
  corePrincipleIds?: readonly PrincipleId[];
}

export interface PolicyCatalog {
  core: PolicySource & { version: string };
  profiles: readonly PolicySource[];
  checks: Readonly<Record<string, CheckRegistration>>;
  skills?: readonly PolicySource[];
  evaluations?: readonly PolicySource[];
}

/** Applicable conflicts reported after the host has resolved its instruction hierarchy. */
export interface InstructionConflict {
  authority: "host" | "user";
  path: string;
  reason: string;
}

export interface PolicyDiagnostic {
  code:
    | "malformed_definition"
    | "duplicate_id"
    | "missing_reference"
    | "unknown_principle"
    | "unknown_check"
    | "profile_cycle"
    | "core_weakening"
    | "incompatible_requirement"
    | "instruction_conflict"
    | "invalid_skill_metadata"
    | "missing_evaluation";
  path: string;
  field: string;
  message: string;
}

export type RequirementOrigin =
  | { kind: "core"; path: string }
  | { kind: "profile"; id: ProfileId; path: string };

export interface EffectiveRequirement {
  id: string;
  kind: CheckKind;
  required: boolean;
  principleIds: PrincipleId[];
  origins: RequirementOrigin[];
}

export interface LocatedProfile {
  path: string;
  definition: ProfileDefinition;
}

export interface EffectivePolicy {
  identity: PolicyIdentity;
  principles: PrincipleDefinition[];
  profiles: LocatedProfile[];
  requirements: EffectiveRequirement[];
}

export interface PolicyResolution {
  policy?: EffectivePolicy;
  diagnostics: PolicyDiagnostic[];
}

export interface CheckObservation {
  id: string;
  kind: CheckKind;
  outcome: EvidenceOutcome;
}

export interface PolicyAssessment {
  outcome: EvidenceOutcome;
  checks: (EffectiveRequirement & { outcome: EvidenceOutcome })[];
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
