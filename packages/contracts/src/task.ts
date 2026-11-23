import { z } from "zod";
import { policyIdentitySchema } from "./policy.js";
import { capabilityIdSchema, identifier, text, timeoutMs } from "./shared.js";

export const criterionSchema = z.strictObject({
  id: identifier,
  description: text,
  required: z.boolean(),
});
export type Criterion = z.infer<typeof criterionSchema>;

export const runLimitsSchema = z.strictObject({
  timeoutMs,
  maxAttempts: z.int().positive(),
  maxConcurrency: z.int().positive(),
});
export type RunLimits = z.infer<typeof runLimitsSchema>;

export const taskBriefSchema = z.strictObject({
  id: identifier,
  parentId: identifier.optional(),
  objective: text,
  ownedPaths: z.array(text).min(1),
  policy: policyIdentitySchema,
  criteria: z.array(criterionSchema).min(1),
  requiredCapabilities: z.array(capabilityIdSchema),
  limits: runLimitsSchema,
});
export type TaskBrief = z.infer<typeof taskBriefSchema>;
