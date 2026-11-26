import { evaluationCaseSchema } from "@axiom/contracts";
import type { EvidenceOutcome } from "@axiom/contracts";
import { gradeCanonicalModel, gradeChangeBoundary, gradeFormatter, gradeProtectedArtifact, gradeUnavailableVerification } from "./artifacts.js";
import { blocked } from "./observation.js";
import type { GradingObservation } from "./observation.js";
import { gradeClarification, gradeContext, gradeDelegation, gradeRegression } from "./traces.js";

export type { GradingAction, GradingObservation } from "./observation.js";

interface Grader {
  readonly kind: "deterministic" | "behavioral";
  grade(caseVersion: string, observation: GradingObservation): EvidenceOutcome;
}

export interface AssertionGrade {
  readonly criterionId: string;
  readonly required: boolean;
  readonly kind: Grader["kind"] | "unregistered";
  readonly outcome: EvidenceOutcome;
}

// Case-version bindings are held by the verifier outside the fixture staged for the agent.
function deterministic<Expected>(
  cases: Readonly<Record<string, Expected>>,
  grade: (expected: Expected, observation: GradingObservation) => EvidenceOutcome,
): Grader {
  return {
    kind: "deterministic",
    grade(caseVersion, observation) {
      if (!Object.hasOwn(cases, caseVersion)) return blocked(`No trusted expectation for ${caseVersion}.`);
      return grade(cases[caseVersion]!, observation);
    },
  };
}

const repairCase = "settled-catalog-repair@1";
const designCase = "reuse-summary-formatter@1";
const commandPath = "src/catalog-command.mjs";
const regressionPath = "test/catalog-command.test.mjs";
export const unavailablePreviewCase = {
  id: "report-unavailable-preview", version: "1", grader: "artifact.unavailable-verification",
  criterion: "preview-layout", report: "verification.json", capabilityFile: "capabilities.json",
} as const;

const graders: Readonly<Record<string, Grader>> = {
  "trace.context-discovery": deterministic({
    [repairCase]: { reads: ["issue.txt", "AGENTS.md"], edit: commandPath },
    "inspect-repository@1": { reads: ["AGENTS.md", "src/AGENTS.md", "README.md", "issue.txt", "package.json"], edit: "src/summary.mjs" },
  }, gradeContext),
  "trace.clarify-before-edit": deterministic({
    "resolve-format-decision@1": "report format",
    "clarify-material-decision@1": "target audience",
  }, gradeClarification),
  "artifact.existing-formatter": deterministic({
    [repairCase]: { path: commandPath, module: "./catalog-key.mjs", symbol: "formatCatalogKey" },
    [designCase]: { path: "command.mjs", module: "./summary-format.mjs", symbol: "formatSummary" },
  }, gradeFormatter),
  "artifact.canonical-model": deterministic({
    [repairCase]: {
      command: commandPath,
      owner: "src/catalog-model.mjs",
      module: "./catalog-model.mjs",
      model: "CatalogKey",
    },
  }, gradeCanonicalModel),
  "artifact.command-boundary": deterministic({
    [repairCase]: [commandPath, regressionPath],
    [designCase]: ["command.mjs"],
  }, gradeChangeBoundary),
  "artifact.preserve-acceptance": deterministic({
    [repairCase]: "test/catalog-acceptance.test.mjs",
  }, gradeProtectedArtifact),
  "trace.native-regression": deterministic({
    [repairCase]: {
      commandPath,
      regressionPath,
      criterion: "demonstrate-prevention",
      regressionTest: "formats multiword catalog keys",
      acceptanceTest: "catalog command acceptance",
    },
  }, gradeRegression),
  "trace.delegation": deterministic({
    "preserve-delegated-requirements@1": {
      parent: "notification-copy",
      ownedPath: "src/notifications.mjs",
      protectedTest: "notifications.test.mjs",
      criterion: "notification-label",
      description: 'Return "Subscribed" from subscriptionLabel.',
      test: "subscription displays the confirmed label",
    },
  }, gradeDelegation),
  [unavailablePreviewCase.grader]: deterministic({
    [`${unavailablePreviewCase.id}@${unavailablePreviewCase.version}`]: unavailablePreviewCase,
  }, gradeUnavailableVerification),
  "review.prevention-scope": {
    kind: "behavioral",
    grade: (caseVersion) => caseVersion === repairCase
      ? { status: "not_run", reason: "An independent reviewer must assess root-cause coverage and proportionate reuse." }
      : blocked(`No trusted expectation for ${caseVersion}.`),
  },
};

/**
 * Evaluate a trusted case definition using snapshots and tool observations captured by the verifier.
 * Fixture staging excludes this registry and case assertions. The tested agent receives the prompt and
 * fixture files. Its final narrative and any self-reported scores are outside the grading input.
 *
 * Deterministic graders check case-specific source structure, file boundaries and observed action
 * sequences. Behavioral review assesses judgment beyond those fixture conditions. Preserve each
 * assertion outcome so mandatory failures remain visible to the benchmark's completion gate.
 */
export function gradeCase(definition: unknown, observation: GradingObservation): AssertionGrade[] {
  const evaluation = evaluationCaseSchema.parse(definition);
  const caseVersion = `${evaluation.id}@${evaluation.version}`;
  return evaluation.assertions.map(({ id, required, grader }) => {
    const evaluator = Object.hasOwn(graders, grader) ? graders[grader] : undefined;
    return {
      criterionId: id,
      required,
      kind: evaluator?.kind ?? "unregistered",
      outcome: evaluator?.grade(caseVersion, observation) ?? blocked(`Grader ${grader} is not registered.`),
    };
  });
}
