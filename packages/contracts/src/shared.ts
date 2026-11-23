import { z } from "zod";

export const text = z.string().refine((value) => value.trim().length > 0, "Expected nonblank text");
export const identifier = z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const durationMs = z.number().nonnegative();
export const timeoutMs = z.int().positive();

export const resultStatusSchema = z.enum(["passed", "failed", "blocked", "not_run", "not_applicable"]);
export type ResultStatus = z.infer<typeof resultStatusSchema>;

export const evidenceOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: resultStatusSchema.extract(["passed"]), reason: text.optional() }),
  z.strictObject({ status: resultStatusSchema.exclude(["passed"]), reason: text }),
]);
export type EvidenceOutcome = z.infer<typeof evidenceOutcomeSchema>;

export const capabilityIdSchema = identifier;
export const capabilitySchema = z.discriminatedUnion("available", [
  z.strictObject({ id: capabilityIdSchema, available: z.literal(true) }),
  z.strictObject({ id: capabilityIdSchema, available: z.literal(false), reason: text }),
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const hostIdentitySchema = z.strictObject({
  agent: identifier,
  version: text,
  model: text,
  os: text,
  surface: text,
});
export type HostIdentity = z.infer<typeof hostIdentitySchema>;

export const artifactReferenceSchema = z.strictObject({
  kind: identifier,
  location: text,
  digest: digestSchema.optional(),
});
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
