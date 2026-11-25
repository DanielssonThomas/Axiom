import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { digestSchema, evidenceSchema, policyIdentitySchema, sourceIdentitySchema, type EvidenceOutcome } from "@axiom/contracts";
import { EvidenceStore } from "@axiom/evidence";
import { gradeCase, type GradingAction } from "@axiom/graders";
import { reviewedCases, reviewedGrader, standardQualification, type BenchmarkArchive } from "./benchmark-archive.js";
import { prepareReviewedBaseline, requireCleanBenchmarkRevision, sha256, type ReviewedBaseline } from "./reviewed-baseline.js";

// Preserve replay of archives produced before usage was made informational.
const legacyStandardQualification = {
  status: "blocked", reason: "Standard native diagnostics do not establish strict budget enforcement or release qualification.",
};

function snapshot(value: unknown): Map<string, string> {
  if (!Array.isArray(value) || value.some((item: unknown) => !Array.isArray(item) || item.length !== 2
      || typeof item[0] !== "string" || typeof item[1] !== "string")) throw new Error("Invalid saved workspace snapshot.");
  const files = new Map<string, string>(value);
  if (files.size !== value.length) throw new Error("Duplicate workspace paths.");
  return files;
}

export async function reviewNativeBenchmark(repository: string, directory: string, expectedDigest: string) {
  let baseline: ReviewedBaseline | undefined;
  try {
    const bytes = await readFile(join(directory, "benchmark.json"));
    if (sha256(bytes) !== digestSchema.parse(expectedDigest)) throw new Error("Benchmark summary digest mismatch.");
    const saved = JSON.parse(bytes.toString("utf8")) as BenchmarkArchive;
    if (saved.sourceFresh !== true) throw new Error("Trusted source freshness was not established.");
    const revision = await requireCleanBenchmarkRevision(repository);
    if (saved.revision !== revision) throw new Error("Benchmark evidence belongs to a different source revision.");
    if (saved.mode === "standard") {
      const legacy = "hardBudgetEnforcement" in saved;
      if ((saved.provider !== "native-account" && saved.provider !== "injected") ||
          saved.metering.metering !== "unknown" || (legacy && saved.hardBudgetEnforcement !== "unavailable") ||
          !isDeepStrictEqual(saved.qualification, legacy ? legacyStandardQualification : standardQualification)) {
        throw new Error("Invalid standard benchmark controls.");
      }
    } else if (saved.mode !== "strict" || (saved.provider !== "injected" && saved.provider !== "anthropic-messages")) {
      throw new Error("Unknown benchmark controls.");
    }
    baseline = await prepareReviewedBaseline(repository, tmpdir(), revision, saved);
    if (await reviewedGrader(repository, baseline.directory) !== saved.report.grader.digest) throw new Error("Grader identity differs.");
    const catalog = await reviewedCases(baseline.directory);
    const store = new EvidenceStore(directory);
    const reviews = [];
    for (const attempt of saved.report.attempts) {
      if (attempt.runtime !== undefined && attempt.runtime !== (saved.mode === "standard" ? "native" : "isolated")) {
        throw new Error("The runtime differs from the recorded benchmark mode.");
      }
      const id = evidenceSchema.shape.id.parse(attempt.id);
      const observed = saved.observations[id];
      if (!observed) {
        if (attempt.assertions.some((item) => item.evidenceId)) throw new Error("A grading observation is missing.");
        reviews.push({ id, outcome: { status: "not_run" as const, reason: "No grading observation was recorded." } });
        continue;
      }
      if (observed.location !== `${id}.grading.json` ||
          (await store.artifact({ kind: "grading-observation", path: observed.location }))?.digest !== observed.digest) {
        throw new Error("A grading observation is missing or changed.");
      }
      const value = JSON.parse(await readFile(join(directory, observed.location), "utf8")) as Record<string, unknown>;
      const evaluation = catalog.find(({ id, version }) => id === attempt.case.id && version === attempt.case.version);
      if (!evaluation || !isDeepStrictEqual(value.evaluation, evaluation)) throw new Error("Saved case differs from the reviewed case.");
      const source = sourceIdentitySchema.parse(value.source);
      const policy = policyIdentitySchema.parse(value.policy);
      if (!isDeepStrictEqual(source, attempt.source) || !isDeepStrictEqual(policy, saved.report.policy)) {
        throw new Error("Grading observation source or policy differs from the recorded attempt.");
      }
      const actions = Array.isArray(value.actions) ? value.actions as GradingAction[] : undefined;
      for (const action of actions ?? []) {
        if (action.kind !== "check") continue;
        const record = evidenceSchema.parse(action.evidence);
        if (record.taskId !== id || !isDeepStrictEqual(record.host, attempt.execution?.host) ||
            !isDeepStrictEqual(record.source, source) || !isDeepStrictEqual(record.policy, policy) ||
            !isDeepStrictEqual(await store.read("acceptance", record.id), record)) {
          throw new Error("An independent capability receipt is missing or changed.");
        }
      }
      const assertions = gradeCase(evaluation, {
        source, policy, before: snapshot(value.before), after: snapshot(value.after),
        ...(actions === undefined ? {} : { actions }),
      });
      if (!isDeepStrictEqual(assertions, value.assertions)) throw new Error("Independent grading differs from the recorded observation.");
      for (const assertion of assertions) {
        const item = attempt.assertions.find(({ id }) => id === assertion.criterionId);
        if (!item?.evidenceId) throw new Error("An assertion receipt is missing.");
        const receipt = await store.read("acceptance", item.evidenceId);
        if (!receipt || receipt.provenance !== "observed" || receipt.taskId !== id ||
            !receipt.criterionIds.includes(assertion.criterionId) || !isDeepStrictEqual(receipt.host, attempt.execution?.host) ||
            !isDeepStrictEqual(receipt.source, source) || !isDeepStrictEqual(receipt.policy, policy) ||
            !isDeepStrictEqual(receipt.outcome, assertion.outcome) || !isDeepStrictEqual(item.outcome, assertion.outcome)) {
          throw new Error("A required assertion receipt differs from the replay.");
        }
        for (const artifact of receipt.artifacts) {
          const observed = await store.artifact({ kind: artifact.kind, path: artifact.location });
          if (!isDeepStrictEqual(observed, artifact)) throw new Error("A native observation artifact is missing or changed.");
        }
      }
      reviews.push({ id, assertions });
    }
    if (await requireCleanBenchmarkRevision(repository) !== revision) throw new Error("The review checkout changed.");
    const outcome: EvidenceOutcome = reviews.length && reviews.every((item) => Array.isArray(item.assertions))
      ? { status: "passed" } : { status: "blocked", reason: "At least one benchmark attempt lacks a grading observation." };
    return { outcome, report: {
      review: "evidence-replay", mode: saved.mode, provider: saved.provider, revision, benchmarkOutcome: saved.outcome,
      baselineDigest: saved.baselineDigest, reviews,
      ...(saved.mode === "standard" && { qualification: saved.qualification, metering: saved.metering,
        ...("hardBudgetEnforcement" in saved && { hardBudgetEnforcement: saved.hardBudgetEnforcement }) }),
    } };
  } catch {
    return { outcome: { status: "blocked", reason: "The trusted summary, reviewed grader, or recorded evidence could not be reproduced." } as EvidenceOutcome };
  } finally {
    if (baseline) await rm(baseline.directory, { recursive: true, force: true });
  }
}
