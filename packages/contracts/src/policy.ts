import { z } from "zod";
import { digestSchema, identifier, text } from "./shared.js";

export const principleIdSchema = z.string().regex(/^AX-\d{2,}$/);
export type PrincipleId = z.infer<typeof principleIdSchema>;

export const profileIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export type ProfileId = z.infer<typeof profileIdSchema>;

export const principleDefinitionSchema = z.strictObject({
  id: principleIdSchema,
  version: text,
  source: text,
});
export type PrincipleDefinition = z.infer<typeof principleDefinitionSchema>;

export const policyDefinitionSchema = z.strictObject({
  version: text,
  principles: z.array(principleDefinitionSchema).min(1),
});
export type PolicyDefinition = z.infer<typeof policyDefinitionSchema>;

export const profileReferenceSchema = z.strictObject({
  id: profileIdSchema,
  version: text,
});
export type ProfileReference = z.infer<typeof profileReferenceSchema>;

export const profileDefinitionSchema = profileReferenceSchema.extend({
  extends: z.array(profileIdSchema),
  principleIds: z.array(principleIdSchema),
  checks: z.array(z.strictObject({
    id: identifier,
    required: z.boolean(),
    principleIds: z.array(principleIdSchema).min(1),
  })),
});
export type ProfileDefinition = z.infer<typeof profileDefinitionSchema>;

export const policyIdentitySchema = z.strictObject({
  version: text,
  digest: digestSchema,
  profiles: z.array(profileReferenceSchema),
});
export type PolicyIdentity = z.infer<typeof policyIdentitySchema>;
