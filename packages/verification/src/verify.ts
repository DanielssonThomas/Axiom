import { randomUUID } from "node:crypto";
import { capabilitySchema, hostIdentitySchema, type Capability, type EvidenceOutcome, type HostIdentity } from "@axiom/contracts";
import { assessEvidence, captureCommandEvidence, type EvidenceStore, type SourceScope } from "@axiom/evidence";
import type { PlannedCheck, VerificationCheckResult, VerificationPlan, VerificationReport } from "./model.js";
import { planVerification } from "./plan.js";
import { runCommand } from "./process.js";

export interface VerificationExecutionRequest {
  plan: VerificationPlan;
  store: EvidenceStore;
  capabilities?: readonly Capability[];
  host?: HostIdentity;
  signal?: AbortSignal;
  sensitiveValues?: readonly string[];
}

export interface VerificationRun {
  id: string;
  plan: VerificationPlan;
  host?: HostIdentity;
  report: VerificationReport;
}

function blocked(reason: string): EvidenceOutcome {
  return { status: "blocked", reason };
}

function checkResult(check: PlannedCheck, outcome: EvidenceOutcome, evidenceId?: string): VerificationCheckResult {
  return {
    id: check.id, criterionId: check.criterionId, kind: check.kind, required: check.required,
    outcome, ...(evidenceId === undefined ? {} : { evidenceId }),
  };
}

function reportChecks(checks: VerificationCheckResult[]): VerificationReport {
  return {
    conforms: checks.every((check) => !check.required || check.outcome.status === "passed"),
    checks,
  };
}

async function checkCurrent(plan: VerificationPlan, check: PlannedCheck): Promise<boolean> {
  const current = await planVerification(plan).catch(() => undefined);
  const candidate = current?.checks.find(({ id, criterionId }) => id === check.id && criterionId === check.criterionId);
  return JSON.stringify(candidate) === JSON.stringify(check);
}

function verificationSource(plan: VerificationPlan): SourceScope {
  return { root: plan.root, extraFiles: [...new Set(plan.checks.flatMap(({ sources }) => sources.map(({ path }) => path)))] };
}

/** Evaluate the final source and artifacts behind every recorded result again. */
export async function assessVerification(run: VerificationRun, store: EvidenceStore): Promise<VerificationReport> {
  const assessment = await assessEvidence({
    task: run.plan.task,
    source: verificationSource(run.plan),
    store,
    ...(run.host === undefined ? {} : { host: run.host }),
    checks: run.report.checks.flatMap((check) => check.evidenceId === undefined ? [] :
      [{ criterionId: check.criterionId, evidenceIds: [check.evidenceId] }]),
  });
  return reportChecks(run.plan.checks.map((planned) => {
    const check = run.report.checks.find(({ id, criterionId }) => id === planned.id && criterionId === planned.criterionId);
    if (!check) return checkResult(planned, { status: "not_run", reason: "No execution result was recorded." });
    if (!check.evidenceId) {
      return checkResult(planned, check.outcome.status === "passed" ? blocked("The check has no observed execution evidence.") : check.outcome);
    }
    if (check.evidenceId !== `${run.id}.${planned.id}`) {
      return checkResult(planned, blocked("The evidence belongs to a different verification check."));
    }
    const criterion = assessment.criteria.find(({ criterionId }) => criterionId === planned.criterionId);
    const result = criterion?.results.find(({ evidenceId }) => evidenceId === check.evidenceId);
    return checkResult(planned, result?.outcome ?? blocked("The recorded check could not be assessed."), check.evidenceId);
  }));
}

/** Run each mapped command once, then assess all results against the delivered source state. */
export async function executeVerification(request: VerificationExecutionRequest): Promise<VerificationRun> {
  const { plan, store, signal } = request;
  const host = request.host === undefined ? undefined : hostIdentitySchema.parse(request.host);
  const capabilities = new Map((request.capabilities ?? []).map((entry) => {
    const capability = capabilitySchema.parse(entry);
    return [capability.id, capability] as const;
  }));
  const id = randomUUID();
  const checks: VerificationCheckResult[] = [];
  for (const check of plan.checks) {
    if (!check.invocation) {
      checks.push(checkResult(check, check.outcome));
      continue;
    }
    if (signal?.aborted) {
      checks.push(checkResult(check, { status: "not_run", reason: "Execution was cancelled before the check started." }));
      continue;
    }
    if (check.kind !== "automated") {
      const capability = capabilities.get(`live-${check.kind}`);
      if (!capability?.available) {
        checks.push(checkResult(check, blocked(capability?.reason ?? `Live ${check.kind} access is unavailable.`)));
        continue;
      }
    }
    const evidenceId = `${id}.${check.id}`;
    let changed = false;
    try {
      const evidence = await captureCommandEvidence({
        id: evidenceId, task: plan.task, criterionIds: [check.criterionId], source: verificationSource(plan),
        command: check.invocation, store,
        ...(host === undefined ? {} : { host }),
        ...(request.sensitiveValues === undefined ? {} : { sensitiveValues: request.sensitiveValues }),
      }, async (invocation) => {
        changed = !(await checkCurrent(plan, check));
        return changed ? { kind: "unavailable", reason: "observation" } : runCommand(invocation, check.timeoutMs, signal);
      });
      if (changed) {
        checks.push(checkResult(check, blocked("The reviewed command plan changed. Resolve and review it again.")));
      } else {
        await store.record("acceptance", evidence);
        checks.push(checkResult(check, evidence.outcome, evidenceId));
      }
    } catch {
      checks.push(checkResult(check, blocked("Could not establish or store observed command evidence.")));
    }
  }
  const run = { id, plan, ...(host === undefined ? {} : { host }), report: reportChecks(checks) };
  return { ...run, report: await assessVerification(run, store) };
}
