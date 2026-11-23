import { z } from "zod";
import {
  capabilityIdSchema,
  capabilitySchema,
  digestSchema,
  evidenceOutcomeSchema,
  hostIdentitySchema,
  profileReferenceSchema,
} from "@axiom/contracts";
import type { Capability, EvidenceOutcome, HostIdentity } from "@axiom/contracts";
import type { EffectivePolicy, InstructionConflict, PolicyCatalog } from "@axiom/policy";

const text = z.string().refine((value) => value.trim().length > 0, "Expected nonblank text");

const sourceSchema = z.strictObject({
  id: capabilityIdSchema,
  kind: z.enum(["instruction", "skill"]),
  path: text,
  selected: z.boolean(),
  digest: digestSchema.optional(),
});
export type ConfiguredSource = z.infer<typeof sourceSchema>;

// The caller supplies a projection of the native configuration.
export const doctorConfigSchema = z.strictObject({
  profiles: z.array(profileReferenceSchema),
  sources: z.array(sourceSchema),
  host: hostIdentitySchema.optional(),
  supportedHostVersions: z.array(text).min(1).optional(),
  capabilities: z.array(capabilitySchema),
});

const activationStages = z.strictObject({
  discoverable: evidenceOutcomeSchema.optional(),
  loaded: evidenceOutcomeSchema.optional(),
  enforced: evidenceOutcomeSchema.optional(),
});

export const activationObservationSchema = z.strictObject({
  host: hostIdentitySchema,
  path: text,
  digest: digestSchema,
  mechanism: text,
  stages: activationStages,
});
export type ActivationObservation = z.infer<typeof activationObservationSchema>;

type ActivationStage = keyof z.infer<typeof activationStages>;
type ObservedStages = Record<ActivationStage, EvidenceOutcome>;

export interface SourceDiagnosis extends ConfiguredSource, ObservedStages {
  installed: EvidenceOutcome;
  observedDigest?: string;
  mechanism?: string;
}

export interface Diagnostic {
  code: string;
  subject: string;
  status: "failed" | "blocked";
  reason: string;
  remediation: string;
}

export interface Diagnosis {
  diagnostics: Diagnostic[];
  sources: SourceDiagnosis[];
  capabilities: Capability[];
  policy?: EffectivePolicy;
  host?: HostIdentity;
}

export interface DoctorRequest {
  root: string;
  catalog: PolicyCatalog;
  config: unknown;
  /** Host-derived evidence for the reported version/scope. Installation is observed separately. */
  observations?: readonly unknown[];
  instructionConflicts?: readonly InstructionConflict[];
}
