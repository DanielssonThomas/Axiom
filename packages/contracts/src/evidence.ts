import { z } from "zod";
import { policyIdentitySchema } from "./policy.js";
import {
  artifactReferenceSchema,
  digestSchema,
  durationMs,
  evidenceOutcomeSchema,
  hostIdentitySchema,
  identifier,
  text,
} from "./shared.js";

export const sourceIdentitySchema = z.strictObject({
  revision: text.optional(),
  digest: digestSchema,
});
export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;

export const commandEvidenceSchema = z.strictObject({
  executable: text,
  args: z.array(z.string()),
  cwd: text,
  exitCode: z.int().nonnegative().optional(),
  signal: text.optional(),
}).refine(
  (command) => command.exitCode === undefined || command.signal === undefined,
  { path: ["signal"], message: "A command cannot report both an exit code and a termination signal" },
);
export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;

export const evidenceSchema = z.strictObject({
  id: identifier,
  taskId: identifier,
  parentTaskId: identifier.optional(),
  criterionIds: z.array(identifier).min(1),
  policy: policyIdentitySchema,
  host: hostIdentitySchema.optional(),
  source: sourceIdentitySchema,
  provenance: z.enum(["observed", "reported"]),
  startedAt: z.iso.datetime({ offset: true }),
  durationMs,
  command: commandEvidenceSchema.optional(),
  artifacts: z.array(artifactReferenceSchema),
  outcome: evidenceOutcomeSchema,
}).refine(
  (evidence) => evidence.outcome.status !== "passed" || evidence.provenance === "observed",
  { path: ["provenance"], message: "Passing evidence requires observed provenance" },
).refine(
  (evidence) => evidence.outcome.status !== "passed" || !evidence.command || evidence.command.exitCode === 0,
  { path: ["command", "exitCode"], message: "Passing command evidence requires exit code zero" },
);
export type Evidence = z.infer<typeof evidenceSchema>;
