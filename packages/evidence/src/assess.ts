import { hostIdentitySchema, policyIdentitySchema, type Criterion, type EvidenceOutcome, type HostIdentity, type SourceIdentity, type TaskBrief } from "@axiom/contracts";
import { excludeArchive, snapshotSource, type SourceScope } from "./source.js";
import type { EvidenceStore } from "./store.js";

export interface CriterionChecks {
  criterionId: Criterion["id"];
  evidenceIds: readonly string[];
}

export interface EvidenceAssessmentRequest {
  task: Pick<TaskBrief, "id" | "parentId" | "policy" | "criteria">;
  host?: HostIdentity;
  source: SourceScope;
  store: EvidenceStore;
  checks: readonly CriterionChecks[];
}

export interface CheckAssessment {
  evidenceId?: string;
  outcome: EvidenceOutcome;
}

export interface CriterionAssessment {
  criterionId: Criterion["id"];
  required: boolean;
  results: CheckAssessment[];
}

export interface EvidenceAssessment {
  conforms: boolean;
  criteria: CriterionAssessment[];
}

function blocked(reason: string): EvidenceOutcome {
  return { status: "blocked", reason };
}

async function checkRecord(
  request: EvidenceAssessmentRequest,
  source: SourceIdentity | undefined,
  criterionId: string,
  evidenceId: string,
): Promise<EvidenceOutcome> {
  const record = await request.store.read("acceptance", evidenceId).catch(() => null);
  if (record === null) return blocked("The acceptance evidence record is unreadable or invalid.");
  if (!record) return { status: "not_run", reason: "The acceptance evidence record is missing." };
  if (record.taskId !== request.task.id || record.parentTaskId !== request.task.parentId || !record.criterionIds.includes(criterionId)) {
    return blocked("The evidence belongs to a different task or criterion.");
  }
  if (record.provenance !== "observed") return blocked("Reported assertions are not observed evidence.");
  if (!source) return blocked("The current source identity is unavailable.");
  if (record.source.digest !== source.digest) return blocked("The source changed after evidence was captured.");
  if (JSON.stringify(record.policy) !== JSON.stringify(policyIdentitySchema.parse(request.task.policy))) {
    return blocked("The policy or profile identity changed.");
  }
  if (request.host && JSON.stringify(record.host) !== JSON.stringify(hostIdentitySchema.parse(request.host))) {
    return blocked("The host identity changed or was not recorded.");
  }
  for (const artifact of record.artifacts) {
    const current = await request.store.artifact({ kind: artifact.kind, path: artifact.location }).catch(() => undefined);
    if (!current) return blocked("A referenced artifact is missing or unreadable.");
    if (current.digest !== artifact.digest) return blocked("A referenced artifact identity changed or was not recorded.");
  }
  return record.outcome;
}

/** Assess every declared check. Development RED records are outside the acceptance lookup. */
export async function assessEvidence(request: EvidenceAssessmentRequest): Promise<EvidenceAssessment> {
  const source = await snapshotSource(excludeArchive(request.source, request.store.directory)).catch(() => undefined);
  const criteria: CriterionAssessment[] = [];
  for (const criterion of request.task.criteria) {
    const ids = request.checks.filter((check) => check.criterionId === criterion.id).flatMap((check) => check.evidenceIds);
    const results: CheckAssessment[] = [];
    for (const evidenceId of new Set(ids)) {
      results.push({ evidenceId, outcome: await checkRecord(request, source, criterion.id, evidenceId) });
    }
    if (results.length === 0) results.push({ outcome: { status: "not_run", reason: "Check evidence was not specified." } });
    criteria.push({ criterionId: criterion.id, required: criterion.required, results });
  }
  return {
    conforms: criteria.every((criterion) => !criterion.required || criterion.results.every(({ outcome }) => outcome.status === "passed")),
    criteria,
  };
}
