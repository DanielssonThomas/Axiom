import { evidenceOutcomeSchema, evidenceSchema, sourceIdentitySchema } from "@axiom/contracts";
import type { BackendResult, EvaluationCase, EvidenceOutcome } from "@axiom/contracts";
import { assessEvidence, snapshotSource } from "@axiom/evidence";
import type { SourceScope } from "@axiom/evidence";
import { abortable } from "./lifecycle.js";
import { blocked, notRun } from "./model.js";
import type { BenchmarkAttempt, BenchmarkObservation, BenchmarkOptions } from "./model.js";

function resultFor(
  id: string,
  required: boolean,
  results: readonly { criterionId: string; outcome: EvidenceOutcome }[],
): EvidenceOutcome {
  const matches = results.filter((result) => result.criterionId === id);
  if (matches.length === 0) return notRun("The independent grader did not return this assertion.");
  if (matches.length > 1) return blocked("The independent grader returned conflicting assertion records.");
  const parsed = evidenceOutcomeSchema.safeParse(matches[0]?.outcome);
  if (!parsed.success) return blocked("The independent grader returned an invalid outcome.");
  if (required && parsed.data.status === "not_applicable") return blocked("A required assertion cannot be waived.");
  return parsed.data;
}

export async function trustedArtifacts(execution: BackendResult, options: BenchmarkOptions): Promise<BackendResult["artifacts"] | undefined> {
  const artifacts: BackendResult["artifacts"] = [];
  for (const reported of execution.artifacts) {
    const actual = await options.store.artifact({ kind: reported.kind, path: reported.location }).catch(() => undefined);
    if (!actual || (reported.digest !== undefined && reported.digest !== actual.digest)) return;
    artifacts.push(actual);
  }
  return artifacts;
}

export async function gradeAttempt(
  evaluation: EvaluationCase,
  attempt: BenchmarkAttempt,
  observation: Omit<BenchmarkObservation, "source">,
  scope: SourceScope,
  options: BenchmarkOptions,
  signal: AbortSignal,
): Promise<void> {
  const source = await snapshotSource(scope);
  attempt.source = source;
  signal.throwIfAborted();

  const gradingStarted = new Date().toISOString();
  const start = performance.now();
  const grading = await abortable(Promise.resolve().then(() =>
    options.grader.grade(evaluation, { ...observation, source }, signal)), signal);
  const durationMs = performance.now() - start;
  const trustedSource = sourceIdentitySchema.safeParse(grading.source);
  const fresh = trustedSource.success && trustedSource.data.digest === source.digest;
  const assertions = Array.isArray(grading.assertions) ? grading.assertions : [];
  const host = observation.execution.host;
  for (const assertion of attempt.assertions) {
    const outcome = fresh ? resultFor(assertion.id, assertion.required, assertions)
      : blocked("The independent grading evidence is stale.");
    const evidence = evidenceSchema.parse({
      id: `${attempt.id}.${assertion.id}`, taskId: attempt.id, criterionIds: [assertion.id],
      source, policy: options.policy, ...(host ? { host } : {}), provenance: "observed",
      startedAt: gradingStarted, durationMs, outcome, artifacts: observation.execution.artifacts,
    });
    await options.store.record("acceptance", evidence);
    assertion.evidenceId = evidence.id;
  }

  const verified = await assessEvidence({
    task: { id: attempt.id, criteria: evaluation.assertions, policy: options.policy },
    ...(host ? { host } : {}),
    source: scope, store: options.store, checks: attempt.assertions.map(({ id, evidenceId }) => ({
      criterionId: id, evidenceIds: evidenceId ? [evidenceId] : [],
    })),
  });
  for (const assertion of attempt.assertions) {
    assertion.outcome = verified.criteria.find(({ criterionId }) => criterionId === assertion.id)?.results[0]?.outcome
      ?? notRun("No verified evidence was available for the assertion.");
  }
}
