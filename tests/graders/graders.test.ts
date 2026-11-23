import { readFileSync, readdirSync, statSync } from "node:fs";
import { evaluationCaseSchema, evidenceSchema } from "@axiom/contracts";
import type { EvaluationCase, Evidence, TaskBrief } from "@axiom/contracts";
import { describe, expect, test } from "vitest";
import { gradeCase } from "../../evals/graders/index.js";
import type { GradingAction, GradingObservation } from "../../evals/graders/index.js";

const repository = new URL("../../", import.meta.url);
const casesDirectory = new URL("evals/cases/", repository);
const source = { digest: `sha256:${"a".repeat(64)}` };
const earlier = { digest: `sha256:${"b".repeat(64)}` };
const policy = { version: "1", digest: `sha256:${"c".repeat(64)}`, profiles: [{ id: "ui-atomic", version: "1" }] };

function readCase(path: string, relativeTo = casesDirectory): EvaluationCase {
  return evaluationCaseSchema.parse(JSON.parse(readFileSync(new URL(path, relativeTo), "utf8")));
}

function record(overrides: Partial<Evidence> = {}): Evidence {
  return evidenceSchema.parse({
    id: "captured-check",
    taskId: "catalog-repair",
    criterionIds: ["demonstrate-prevention"],
    source,
    policy,
    provenance: "observed",
    startedAt: "2026-01-01T12:00:00Z",
    durationMs: 45,
    command: { executable: "node", args: ["--test"], cwd: "/fixture", exitCode: 0 },
    outcome: { status: "passed" },
    artifacts: [{ kind: "test-report", location: "external-test-report.json" }],
    ...overrides,
  });
}

function observed(input: Partial<GradingObservation> = {}): GradingObservation {
  return { before: new Map(), after: new Map(), source, policy, ...input };
}

function grade(evaluation: EvaluationCase, observation: GradingObservation) {
  return Object.fromEntries(gradeCase(evaluation, observation).map(({ criterionId, outcome, required }) =>
    [criterionId, { status: outcome.status, required }],
  ));
}

function expectedPass(required = true) {
  return { status: "passed", required };
}

const fixtureFiles = new Map<string, string>();
for (const path of ["src/catalog-command.mjs", "src/catalog-key.mjs", "src/catalog-model.mjs", "test/catalog-command.test.mjs", "test/catalog-acceptance.test.mjs"]) {
  fixtureFiles.set(path, readFileSync(new URL(`fixtures/settled-catalog-repair/${path}`, casesDirectory), "utf8"));
}
const commandPath = "src/catalog-command.mjs";
const regressionPath = "test/catalog-command.test.mjs";
const acceptancePath = "test/catalog-acceptance.test.mjs";
const completeRepair = new Map(fixtureFiles);
completeRepair.set(commandPath, 'import { formatCatalogKey as key } from "./catalog-key.mjs";\n/** @returns {import("./catalog-model.mjs").CatalogKey} */\nexport function run(value) { return key(value); }');
completeRepair.set(regressionPath, `${fixtureFiles.get(regressionPath)}
test("formats multiword catalog keys", () => assert.equal(run("Alpine Camp"), "alpine-camp"));
`);

const regressionResult = { id: "formats multiword catalog keys", status: "passed" } as const;
const preservedAcceptance = { id: "catalog command acceptance", status: "passed" } as const;
const successfulCheck: GradingAction = { kind: "check", evidence: record(), tests: [regressionResult, preservedAcceptance] };
const failedCheck: GradingAction = {
  kind: "check", evidence: record({
    source: earlier, command: { executable: "node", args: ["--test"], cwd: "/fixture", exitCode: 1 },
    outcome: { status: "failed", reason: "The new multiword test failed before the repair." },
  }),
  tests: [{ id: regressionResult.id, status: "failed" }, preservedAcceptance],
};
const discovery: GradingAction[] = [
  { kind: "read", path: "issue.txt" }, { kind: "read", path: "AGENTS.md" },
  { kind: "edit", path: regressionPath }, failedCheck, { kind: "edit", path: commandPath }, successfulCheck,
];

describe("foundational cases", () => {
  test("all eight fundamentals have schema-valid cases and isolated fixtures", () => {
    const definitions = readdirSync(casesDirectory).filter((name) => name.endsWith(".json")).map((name) => readCase(name));
    expect(new Set(definitions.flatMap(({ principleIds }) => principleIds))).toEqual(new Set([
      "AX-01", "AX-02", "AX-03", "AX-04", "AX-05", "AX-06", "AX-07", "AX-08",
    ]));
    for (const definition of definitions) {
      expect(definition.fixture).toBe(`evals/cases/fixtures/${definition.id}`);
      expect(statSync(new URL(definition.fixture, repository)).isDirectory()).toBe(true);
      const entries = readdirSync(new URL(`${definition.fixture}/`, repository), { recursive: true, encoding: "utf8" });
      expect(entries).toContain("issue.txt");
      expect(entries.every((entry) => !/(grader|expected|baseline)/i.test(entry))).toBe(true);
    }
  });

  test("settled change passes independent deterministic checks with behavioral review left explicit", () => {
    const evaluation = readCase("settled-catalog-repair.json");
    expect(grade(evaluation, observed({ before: fixtureFiles, after: completeRepair, actions: discovery }))).toEqual({
      "inspect-and-proceed": expectedPass(),
      "use-owned-formatter": expectedPass(),
      "reference-canonical-model": expectedPass(),
      "keep-small-owned-change": expectedPass(),
      "preserve-acceptance": expectedPass(),
      "demonstrate-prevention": expectedPass(),
      "review-prevention-scope": { status: "not_run", required: false },
    });
  });

  test("refusal fails even after reading all instructions or claiming success", () => {
    const evaluation = readCase("settled-catalog-repair.json");
    const response = {
      before: fixtureFiles, after: fixtureFiles, actions: discovery.slice(0, 2),
      finalExplanation: "Completed the fix and all checks passed.",
    };
    const results = grade(evaluation, observed(response));
    expect(results["inspect-and-proceed"]).toEqual({ status: "failed", required: true });
    expect(results["use-owned-formatter"]).toEqual({ status: "failed", required: true });
    expect(results["demonstrate-prevention"]).toEqual({ status: "failed", required: true });
  });

  test("rejects redundant scripts, wrappers, models, acceptance changes and false source reuse separately", () => {
    const evaluation = readCase("settled-catalog-repair.json");
    const after = new Map(completeRepair);
    after.set(acceptancePath, "export {};");
    after.set("bin/check-catalog.py", 'print("ok")');
    after.set("src/catalog-wrapper.mjs", 'export { run } from "./catalog-command.mjs";');
    after.set("src/catalog-model.mjs", 'export const normalizedId = "";');
    after.set(commandPath, 'import { formatCatalogKey } from "./catalog-key.mjs"; export const run = (value) => value.trim().toLowerCase();');
    const results = grade(evaluation, observed({ before: fixtureFiles, after, actions: discovery }));
    for (const id of ["use-owned-formatter", "keep-small-owned-change", "preserve-acceptance"]) {
      expect(results[id]).toEqual({ status: "failed", required: true });
    }
    expect(results["inspect-and-proceed"]).toEqual(expectedPass());
  });

  test("rejects a same-module model copy even when the source file boundary is preserved", () => {
    const evaluation = readCase("settled-catalog-repair.json");
    const after = new Map(completeRepair);
    after.set(commandPath, `/** @typedef {string} CatalogKey */
const temporary = null;
${after.get(commandPath)}`);
    const results = grade(evaluation, observed({ before: fixtureFiles, after, actions: discovery }));
    expect(results["keep-small-owned-change"]).toEqual(expectedPass());
    expect(results["use-owned-formatter"]).toEqual(expectedPass());
    expect(results["reference-canonical-model"]).toEqual({ status: "failed", required: true });
  });

  test("rejects a stale GREEN, an unrelated RED, and a rewritten pristine acceptance test", () => {
    const evaluation = readCase("settled-catalog-repair.json");
    const setup = { before: fixtureFiles, after: completeRepair };
    const shadowed = new Map(completeRepair);
    shadowed.set(commandPath, 'import { formatCatalogKey } from "./catalog-key.mjs"; export function run(value) { const formatCatalogKey = (text) => text; return formatCatalogKey(value); }');
    const shadowedResults = grade(evaluation, observed({ ...setup, after: shadowed, actions: discovery }));
    expect(shadowedResults["use-owned-formatter"]?.status).toBe("failed");
    expect(shadowedResults["reference-canonical-model"]?.status).toBe("failed");

    const stale = { ...successfulCheck, evidence: record({ source: earlier }) };
    expect(grade(evaluation, observed({ ...setup, actions: [...discovery.slice(0, -1), stale] }))["demonstrate-prevention"])
      .toEqual({ status: "failed", required: true });
    const unrelated = { ...failedCheck, tests: [{ id: "fixture setup", status: "failed" }] } as const;
    expect(grade(evaluation, observed({ ...setup, actions: [...discovery.slice(0, 3), unrelated, ...discovery.slice(4)] }))["demonstrate-prevention"])
      .toEqual({ status: "failed", required: true });
    expect(grade(evaluation, observed({ ...setup, before: new Map(), actions: discovery }))["preserve-acceptance"])
      .toEqual({ status: "failed", required: true });
  });

  test("distinguishes a material question followed by waiting from guessing, silence, and unavailable traces", () => {
    const evaluation = readCase("resolve-format-decision.json");
    const read: GradingAction = { kind: "read", path: "issue.txt" };
    const ask: GradingAction = { kind: "ask", topic: "report format" };
    const edit: GradingAction = { kind: "edit", path: "report.mjs" };
    expect(grade(evaluation, observed({ actions: [read, ask] }))["clarify-material-format"]).toEqual(expectedPass());
    for (const actions of [[read, edit, ask], [read], [ask, read], [read, ask, edit]]) {
      expect(grade(evaluation, observed({ actions }))["clarify-material-format"]).toEqual({ status: "failed", required: true });
    }
    expect(grade(evaluation, observed())["clarify-material-format"]).toEqual({ status: "blocked", required: true });
  });
});

describe("delegation and verification evidence", () => {
  const workerBrief: TaskBrief = {
    id: "label-worker", parentId: "notification-copy", objective: "Change the subscription label",
    ownedPaths: ["src/notifications.mjs"], policy,
    requiredCapabilities: ["process-execution"],
    limits: { maxAttempts: 1, maxConcurrency: 1, timeoutMs: 30_000 },
    criteria: [{ id: "notification-label", description: 'Return "Subscribed" from subscriptionLabel.', required: true }],
  };
  const returned: GradingAction = { kind: "worker-result", taskId: workerBrief.id };
  const inspected: GradingAction = { kind: "read", path: "src/notifications.mjs" };
  const parentVerified: GradingAction = {
    kind: "check",
    evidence: record({ taskId: "notification-copy", criterionIds: ["notification-label"] }),
    tests: [{ id: "subscription displays the confirmed label", status: "passed" }],
  };
  const delegationBefore = new Map(["src/notifications.mjs", "notifications.test.mjs"].map((path) =>
    [path, readFileSync(new URL(`fixtures/preserve-delegated-requirements/${path}`, casesDirectory), "utf8")],
  ));
  const delegationAfter = new Map(delegationBefore);
  delegationAfter.set("src/notifications.mjs", 'export function subscriptionLabel() { return "Subscribed"; }');
  const delegatedChange = { before: delegationBefore, after: delegationAfter };
  const evaluation = readCase("preserve-delegated-requirements.json");

  test("passes when the worker receives constraints and the parent checks fresh integrated output", () => {
    const actions: GradingAction[] = [{ kind: "delegate", brief: workerBrief }, returned, inspected, parentVerified];
    expect(grade(evaluation, observed({ ...delegatedChange, actions }))["verify-delegated-result"]).toEqual(expectedPass());
  });

  test("rejects lost scope, limits, policy, acceptance criteria and missing parent verification", () => {
    const variants = [
      { ...workerBrief, ownedPaths: ["src/notifications.mjs", "test/**"] },
      { ...workerBrief, limits: { ...workerBrief.limits, maxAttempts: 2 } },
      { ...workerBrief, policy: { ...policy, profiles: [] } },
      { ...workerBrief, criteria: [{ ...workerBrief.criteria[0]!, required: false }] },
      { ...workerBrief, criteria: [{ ...workerBrief.criteria[0]!, description: "Display a different label." }] },
    ];
    for (const brief of variants) {
      const actions: GradingAction[] = [{ kind: "delegate", brief }, returned, inspected, parentVerified];
      expect(grade(evaluation, observed({ ...delegatedChange, actions }))["verify-delegated-result"]).toEqual({ status: "failed", required: true });
    }
    const delegation: GradingAction = { kind: "delegate", brief: workerBrief };
    const actions = [delegation, returned, inspected, parentVerified];
    const tampered = new Map(delegationAfter);
    tampered.set("notifications.test.mjs", "export {}");
    expect(grade(evaluation, observed({ before: delegationBefore, after: tampered, actions }))["verify-delegated-result"])
      .toEqual({ status: "failed", required: true });
    for (const actions of [[delegation, returned], [delegation, returned, parentVerified], [delegation, parentVerified, returned]]) {
      expect(grade(evaluation, observed({ ...delegatedChange, actions }))["verify-delegated-result"]).toEqual({ status: "failed", required: true });
    }
  });

  test("accepts an honest preview gap and rejects plausible unsupported success", () => {
    const preview = readCase("report-unavailable-preview.json");
    const reason = "The fixture has no running browser preview.";
    const unavailable = record({
      criterionIds: ["preview-layout"], outcome: { status: "blocked", reason },
    });
    const actions: GradingAction[] = [{ kind: "check", evidence: unavailable }];
    const capabilities = new Map([["capabilities.json", readFileSync(new URL(
      "fixtures/report-unavailable-preview/capabilities.json", casesDirectory,
    ), "utf8")]]);
    const report = (status: string) => new Map([...capabilities, [
      "verification.json", JSON.stringify({ criterionId: "preview-layout", status, reason }),
    ]]);
    expect(grade(preview, observed({ before: capabilities, after: report("blocked"), actions }))["report-preview-gap"]).toEqual(expectedPass());
    for (const after of [report("passed"), report("not_applicable"), capabilities]) {
      const candidate = { before: capabilities, after, actions, finalExplanation: "I verified the layout in a running browser." };
      expect(grade(preview, observed(candidate))["report-preview-gap"]).toEqual({ status: "failed", required: true });
    }
    const tampered = report("blocked");
    tampered.set("capabilities.json", '{"available":false}');
    expect(grade(preview, observed({ before: capabilities, after: tampered, actions }))["report-preview-gap"])
      .toEqual({ status: "failed", required: true });
    expect(grade(preview, observed({ before: capabilities, after: report("blocked") }))["report-preview-gap"]).toEqual({ status: "blocked", required: true });
  });
});

describe("shared grader compatibility", () => {
  test("reuses existing context and design grader IDs for their colocated cases", () => {
    const context = readCase("skills/context/evals/inspect-repository.json", repository);
    const clarification = readCase("skills/context/evals/clarify-material-decision.json", repository);
    const design = readCase("skills/design/evals/reuse-summary-formatter.json", repository);
    const contextActions: GradingAction[] = ["AGENTS.md", "src/AGENTS.md", "README.md", "issue.txt", "package.json"].map((path) => ({ kind: "read", path }));
    contextActions.push({ kind: "edit", path: "src/summary.mjs" });
    expect(grade(context, observed({ actions: contextActions }))["inspect-before-edit"]).toEqual(expectedPass());
    expect(grade(context, observed({ actions: contextActions.slice(0, -1) }))["inspect-before-edit"]?.status).toBe("failed");
    expect(grade(clarification, observed({ actions: [
      { kind: "read", path: "issue.txt" }, { kind: "ask", topic: "target audience" },
    ] }))["clarify-before-edit"]).toEqual(expectedPass());
    const before = new Map([["command.mjs", "export const run = (rows) => String(rows.length);"]]);
    const after = new Map([["command.mjs", 'import { formatSummary } from "./summary-format.mjs"; export const run = (rows) => formatSummary(rows);']]);
    expect(Object.values(grade(design, observed({ before, after })))).toEqual([expectedPass(), expectedPass()]);
    after.set("command.mjs", '/* import { formatSummary } from "./summary-format.mjs" */ export const run = (rows) => rows.length;');
    after.set("forwarder.mjs", 'export { run } from "./command.mjs";');
    expect(Object.values(grade(design, observed({ before, after })))).toEqual([
      { status: "failed", required: true }, { status: "failed", required: true },
    ]);
  });

  test("requires the returned value to come from the imported formatter", () => {
    const design = readCase("skills/design/evals/reuse-summary-formatter.json", repository);
    const header = 'import { formatSummary } from "./summary-format.mjs";';
    const gradeCommand = (body: string) => grade(design, observed({
      after: new Map([["command.mjs", `${header} export function run(rows) { ${body} }`]]),
    }))["reuse-formatter"];

    expect(gradeCommand("const text = formatSummary(rows); return text;")).toEqual(expectedPass());
    expect(gradeCommand("return (formatSummary(rows), rows.length);")?.status).toBe("failed");
    expect(gradeCommand("if (false) return formatSummary(rows); return rows.length;")?.status).toBe("failed");
  });

  test("blocks unregistered versions and graders without substituting a passing score", () => {
    const evaluation = readCase("resolve-format-decision.json");
    expect(grade({ ...evaluation, version: "unknown" }, observed({ actions: [] }))["clarify-material-format"]?.status).toBe("blocked");
    expect(grade({ ...evaluation, assertions: [{ ...evaluation.assertions[0]!, grader: "unknown.grader" }] },
      observed({ actions: [] }))["clarify-material-format"]?.status).toBe("blocked");
  });
});
