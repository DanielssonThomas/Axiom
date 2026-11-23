import { z } from "zod";
import { policyIdentitySchema, principleIdSchema, profileReferenceSchema } from "./policy.js";
import {
  artifactReferenceSchema,
  capabilityIdSchema,
  durationMs,
  evidenceOutcomeSchema,
  hostIdentitySchema,
  identifier,
  text,
  timeoutMs,
} from "./shared.js";
import { criterionSchema } from "./task.js";

export const evaluationCaseSchema = z.strictObject({
  id: identifier,
  version: text,
  skill: z.strictObject({ id: identifier, version: text }).optional(),
  profiles: z.array(profileReferenceSchema),
  fixture: text,
  prompt: text,
  principleIds: z.array(principleIdSchema).min(1),
  requiredCapabilities: z.array(capabilityIdSchema),
  assertions: z.array(criterionSchema.extend({ grader: identifier })).min(1),
});
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;

// The benchmark owns grading and passes only the execution inputs to the backend.
export const backendRequestSchema = z.strictObject({
  id: identifier,
  caseId: identifier,
  prompt: text,
  workspace: text,
  host: hostIdentitySchema,
  policy: policyIdentitySchema,
  mode: z.enum(["with_axiom", "without_axiom"]),
  timeoutMs,
});
export type BackendRequest = z.infer<typeof backendRequestSchema>;

const measuredUsageSchema = z.strictObject({
  metering: z.literal("reported"),
  inputTokens: z.int().nonnegative().optional(),
  outputTokens: z.int().nonnegative().optional(),
  cost: z.strictObject({ amount: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }).optional(),
});

export const usageSchema = z.discriminatedUnion("metering", [
  z.strictObject({ metering: z.literal("unknown"), reason: text }),
  measuredUsageSchema,
]).refine(
  (usage) => usage.metering === "unknown"
    || usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.cost !== undefined,
  "Reported usage requires at least one measurement",
);
export type Usage = z.infer<typeof usageSchema>;

export const backendResultSchema = z.strictObject({
  requestId: identifier,
  host: hostIdentitySchema.optional(),
  outcome: evidenceOutcomeSchema,
  durationMs,
  artifacts: z.array(artifactReferenceSchema),
  usage: usageSchema,
}).refine(
  (result) => result.outcome.status !== "passed" || result.host !== undefined,
  { path: ["host"], message: "Successful execution requires an observed host identity" },
);
export type BackendResult = z.infer<typeof backendResultSchema>;

export interface BenchmarkBackend {
  run(request: BackendRequest, signal: AbortSignal): Promise<BackendResult>;
}
