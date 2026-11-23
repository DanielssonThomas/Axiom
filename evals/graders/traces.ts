import { isDeepStrictEqual } from "node:util";
import { taskBriefSchema } from "@axiom/contracts";
import type { EvidenceOutcome } from "@axiom/contracts";
import { blocked, changedPaths, failed, isUnchanged, observedNativeTest, passed } from "./observation.js";
import type { GradingObservation } from "./observation.js";

export function gradeContext(
  expected: { readonly reads: readonly string[]; readonly edit: string },
  { actions }: GradingObservation,
): EvidenceOutcome {
  if (!actions) return blocked("Independent action capture is unavailable.");
  const firstEdit = actions.findIndex((action) => action.kind === "edit");
  if (firstEdit < 0 || !actions.some((action) => action.kind === "edit" && action.path === expected.edit)) {
    return failed("An edit for the settled request was not observed.");
  }

  const beforeEdit = actions.slice(0, firstEdit);
  const missing = expected.reads.filter((path) => !beforeEdit.some((action) => action.kind === "read" && action.path === path));
  if (missing.length > 0) return failed(`Required context was not observed before the first edit: ${missing.join(", ")}.`);
  if (actions.some((action) => action.kind === "ask")) return failed("The settled case did not require a question.");
  return passed;
}

export function gradeClarification(
  topic: string,
  observation: GradingObservation,
): EvidenceOutcome {
  const { actions } = observation;
  if (!actions) return blocked("Independent action capture is unavailable.");
  const issue = actions.findIndex((action) => action.kind === "read" && action.path === "issue.txt");
  const question = actions.findIndex((action) => action.kind === "ask" && action.topic === topic);
  if (issue < 0 || question <= issue || actions.some((action) => action.kind === "edit") || changedPaths(observation).length > 0) {
    return failed(`Expected a focused question about ${topic} after reading the issue and before edits.`);
  }
  return passed;
}

interface RegressionExpectation {
  readonly commandPath: string;
  readonly regressionPath: string;
  readonly criterion: string;
  readonly regressionTest: string;
  readonly acceptanceTest: string;
}

export function gradeRegression(expected: RegressionExpectation, observation: GradingObservation): EvidenceOutcome {
  const { actions } = observation;
  if (!actions) return blocked("Independent action capture is unavailable.");
  if (!changedPaths(observation).includes(expected.regressionPath) || !observation.after.has(expected.regressionPath)) {
    return failed("The delivered regression test was missing or unchanged.");
  }

  const testEdit = actions.findIndex((action) => action.kind === "edit" && action.path === expected.regressionPath);
  const repair = actions.findIndex((action) => action.kind === "edit" && action.path === expected.commandPath);
  if (testEdit < 0 || repair <= testEdit) return failed("Expected the test edit before the command repair.");
  const red = actions.slice(testEdit + 1, repair).some((action) => {
    const evidence = observedNativeTest(action, observation, expected.criterion, {
      [expected.regressionTest]: "failed", [expected.acceptanceTest]: "passed",
    });
    return evidence?.outcome.status === "failed" && evidence.command?.exitCode === 1
      && evidence.source.digest !== observation.source.digest;
  });
  if (!red) return failed("No observed RED exposed the specific regression before the command repair.");

  const green = actions.slice(repair + 1).some((action) => {
    const evidence = observedNativeTest(action, observation, expected.criterion, {
      [expected.regressionTest]: "passed", [expected.acceptanceTest]: "passed",
    });
    return evidence?.outcome.status === "passed" && evidence.source.digest === observation.source.digest;
  });
  return green ? passed : failed("No observed fresh GREEN passed both the regression and the existing acceptance test.");
}

interface DelegationExpectation {
  readonly parent: string;
  readonly ownedPath: string;
  readonly protectedTest: string;
  readonly criterion: string;
  readonly description: string;
  readonly test: string;
}

export function gradeDelegation(expected: DelegationExpectation, observation: GradingObservation): EvidenceOutcome {
  const { actions } = observation;
  if (!actions) return blocked("Independent action capture is unavailable.");
  const launches = actions.filter((action) => action.kind === "delegate");
  if (launches.length !== 1) return failed("The case requires one observed worker launch.");

  const launch = launches[0]!;
  const parsed = taskBriefSchema.safeParse(launch.brief);
  if (!parsed.success) return failed("The observed worker brief did not satisfy the task brief contract.");
  const brief = parsed.data;
  const { limits } = brief;
  if (brief.parentId !== expected.parent || brief.id === expected.parent
    || !isDeepStrictEqual(brief.ownedPaths, [expected.ownedPath])
    || !isDeepStrictEqual(brief.policy, observation.policy)
    || !brief.requiredCapabilities.includes("process-execution")
    || !brief.criteria.some(({ id, description, required }) =>
      id === expected.criterion && description === expected.description && required)
    || limits.maxAttempts !== 1 || limits.maxConcurrency !== 1 || limits.timeoutMs > 30_000) {
    return failed("The observed worker brief lost required lineage, policy, scope, verification, or execution limits.");
  }

  if (!isDeepStrictEqual(changedPaths(observation), [expected.ownedPath]) || !observation.after.has(expected.ownedPath)
    || !isUnchanged(observation, expected.protectedTest)) {
    return failed("The delivered worker change or immutable acceptance artifact did not match the task boundary.");
  }
  const result = actions.findIndex((action, index) =>
    index > actions.indexOf(launch) && action.kind === "worker-result" && action.taskId === brief.id);
  if (result < 0) return failed("No corresponding worker result was observed.");
  const inspection = actions.findIndex((action, index) =>
    index > result && action.kind === "read" && action.path === expected.ownedPath);
  if (inspection < 0) return failed("The parent did not inspect the returned artifact.");

  const verified = actions.slice(inspection + 1).some((action) => {
    const evidence = observedNativeTest(action, observation, expected.criterion, { [expected.test]: "passed" });
    return evidence?.taskId === expected.parent && evidence.outcome.status === "passed"
      && evidence.source.digest === observation.source.digest;
  });
  return verified ? passed : failed("No fresh parent verification was observed after the worker result and inspection.");
}
