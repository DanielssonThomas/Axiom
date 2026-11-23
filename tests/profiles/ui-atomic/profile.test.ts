import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  evaluationCaseSchema,
  evidenceSchema,
  profileDefinitionSchema,
} from "@axiom/contracts";
import type { Evidence } from "@axiom/contracts";
import { describe, expect, test } from "vitest";
import {
  inspectComposition,
  inspectDesignSystemReuse,
  inspectUiVerification,
} from "../../../profiles/ui-atomic/checks.js";
import type {
  CompositionComponent,
  UiCheck,
} from "../../../profiles/ui-atomic/checks.js";

const repository = new URL("../../../", import.meta.url);
const profilePath = new URL("profiles/ui-atomic/", repository);
const evalsPath = new URL("evals/", profilePath);

function readJson(file: URL): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

const graph = [
  { id: "shared.button", level: "atom", owner: "design-system", visibility: "public", dependencies: [] },
  { id: "filters.date-field", level: "atom", owner: "filters", visibility: "owner", dependencies: [] },
  { id: "filters.date-filter", level: "molecule", owner: "filters", visibility: "owner", dependencies: ["shared.button", "filters.date-field"] },
  { id: "filters.toolbar", level: "organism", owner: "filters", visibility: "owner", dependencies: ["filters.date-filter"] },
  { id: "filters.catalog-layout", level: "template", owner: "filters", visibility: "owner", dependencies: ["filters.toolbar"] },
] satisfies CompositionComponent[];

const sources = {
  source: { digest: `sha256:${"a".repeat(64)}` },
  policy: { version: "1", digest: `sha256:${"b".repeat(64)}`, profiles: [{ id: "ui-atomic", version: "1" }] },
};

function observed(criterionId: string, fields?: Partial<Evidence>): Evidence {
  return evidenceSchema.parse({
    id: "browser-run",
    taskId: "catalog-filters",
    criterionIds: [criterionId],
    ...sources,
    provenance: "observed",
    startedAt: "2026-01-01T12:00:00Z",
    durationMs: 120,
    artifacts: [{ kind: "browser-trace", location: "evidence/catalog-filters-trace.json" }],
    outcome: { status: "passed" },
    ...fields,
  });
}

describe("optional UI profile", () => {
  test("declares checks under the shared profile schema and references actual core principles", () => {
    const profile = profileDefinitionSchema.parse(readJson(new URL("profile.json", profilePath)));
    const core = readFileSync(new URL("core/AXIOMS.md", repository), "utf8");
    const coreIds = new Set([...core.matchAll(/^## (AX-\d+) /gm)].map((match) => match[1]));

    expect(profile.id).toBe("ui-atomic");
    expect(profile.extends).toEqual([]);
    expect(profile.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      "ui-atomic.composition", "ui-atomic.reuse", "ui-atomic.verification",
    ]));
    for (const id of [...profile.principleIds, ...profile.checks.flatMap((check) => check.principleIds)]) {
      expect(coreIds.has(id), id).toBe(true);
    }
  });

  test("validates the colocated evaluations and resolves staged fixtures", () => {
    const profile = profileDefinitionSchema.parse(readJson(new URL("profile.json", profilePath)));
    const evals = readdirSync(evalsPath).filter((file) => file.endsWith(".json")).map((file) =>
      evaluationCaseSchema.parse(readJson(new URL(file, evalsPath))),
    );

    expect(evals.map((evaluation) => evaluation.id)).toEqual(expect.arrayContaining([
      "ui-atomic.composition", "ui-atomic.reuse", "ui-atomic.verification",
    ]));
    for (const evaluation of evals) {
      expect(evaluation.profiles).toContainEqual({ id: profile.id, version: profile.version });
      expect(evaluation.principleIds.every((id) => profile.principleIds.includes(id))).toBe(true);
      expect(existsSync(fileURLToPath(new URL(evaluation.fixture, repository)))).toBe(true);
      expect(evaluation.assertions.some((assertion) => assertion.required)).toBe(true);
    }
  });
});

describe("composition boundaries", () => {
  test("accepts a feature layout that composes down through owner-private and shared UI", () => {
    expect(inspectComposition(graph)).toEqual([]);
  });

  test("rejects upward and same-level edges even when there is no cycle", () => {
    const upward = graph.map((component) => component.id === "shared.button"
      ? { ...component, dependencies: ["orders.independent-card"] }
      : component);
    const independentCard: CompositionComponent = {
      id: "orders.independent-card", level: "organism", owner: "orders", visibility: "public", dependencies: [],
    };
    const peer = graph.map((component) => component.id === "filters.date-field"
      ? { ...component, dependencies: ["shared.button"] }
      : component);

    expect(inspectComposition([...upward, independentCard])).toEqual([{
      code: "non-downward-dependency", component: "shared.button", dependency: "orders.independent-card",
    }]);
    expect(inspectComposition(peer)).toContainEqual({
      code: "non-downward-dependency", component: "filters.date-field", dependency: "shared.button",
    });
  });

  test("identifies a closed cycle as well as the invalid layer edge", () => {
    const cyclic = graph.map((component) => component.id === "filters.date-field"
      ? { ...component, dependencies: ["filters.toolbar"] }
      : component);

    expect(inspectComposition(cyclic)).toContainEqual({
      code: "cycle", path: ["filters.date-field", "filters.toolbar", "filters.date-filter", "filters.date-field"],
    });
  });

  test("rejects a lower-layer dependency on another domain's private UI", () => {
    const crossDomain: CompositionComponent = {
      id: "orders.toolbar", level: "organism", owner: "orders", visibility: "owner", dependencies: ["filters.date-filter"],
    };

    expect(inspectComposition([...graph, crossDomain])).toContainEqual({
      code: "private-dependency", component: "orders.toolbar", dependency: "filters.date-filter",
    });
  });

  test("rejects missing and ambiguous graph nodes", () => {
    const bad: CompositionComponent = {
      id: "orders.list", level: "organism", owner: "orders", visibility: "owner", dependencies: ["orders.missing"],
    };
    expect(inspectComposition([...graph, graph[0]!, bad])).toEqual(expect.arrayContaining([
      { code: "duplicate-component", component: "shared.button" },
      { code: "missing-dependency", component: "orders.list", dependency: "orders.missing" },
    ]));
  });
});

describe("reuse of an independently identified compatible component", () => {
  const known = { consumer: "filters.date-filter", compatibleComponents: ["shared.button"] };

  test("accepts the existing accessible button", () => {
    expect(inspectDesignSystemReuse(graph, known)).toEqual({ status: "passed" });
  });

  test("fails a local equivalent even though the graph passes structural checks", () => {
    const duplicate: CompositionComponent = {
      id: "filters.apply-button", level: "atom", owner: "filters", visibility: "owner", dependencies: [],
    };
    const rewritten = graph.map((component) => component.id === known.consumer
      ? { ...component, dependencies: [duplicate.id, "filters.date-field"] }
      : component);
    expect(inspectComposition([...rewritten, duplicate])).toEqual([]);
    expect(inspectDesignSystemReuse([...rewritten, duplicate], known)).toMatchObject({
      status: "failed", reason: expect.stringContaining("shared.button"),
    });
  });

  test("does not pass a case with no known suitable component", () => {
    expect(inspectDesignSystemReuse(graph, { ...known, compatibleComponents: [] })).toMatchObject({
      status: "not_applicable", reason: expect.any(String),
    });
  });
});

describe("UI verification", () => {
  const checks: UiCheck[] = (["layout", "interaction", "responsive", "accessibility"] as const).map((area) => ({
    area,
    method: "live",
    criterion: { id: `live-${area}`, required: true, description: `Observe ${area} in the browser` },
  }));

  test.each(checks)("accepts fresh observed $area evidence with an artifact", (check) => {
    expect(inspectUiVerification(check, { method: "live", evidence: observed(check.criterion.id) }, sources)).toEqual({
      status: "passed",
    });
  });

  test("cannot use an acceptance-test result in place of a required live check", () => {
    const check = checks[1]!;
    const evidence = observed(check.criterion.id, {
      command: { executable: "pnpm", args: ["test"], cwd: "/fixture", exitCode: 0 },
      artifacts: [{ kind: "test-report", location: "evidence/tests.json" }],
    });
    expect(inspectUiVerification({ ...check, method: "acceptance" }, { method: "acceptance", evidence }, sources))
      .toEqual({ status: "passed" });
    expect(inspectUiVerification(check, { method: "acceptance", evidence }, sources))
      .toMatchObject({ status: "not_run", reason: expect.stringContaining("live") });
  });

  test("rejects static output relabelled as a live observation", () => {
    const check = checks[2]!;
    const evidence = observed(check.criterion.id, {
      artifacts: [{ kind: "test-report", location: "evidence/unit-tests.json" }],
    });
    expect(inspectUiVerification(check, { method: "live", evidence }, sources))
      .toMatchObject({ status: "blocked", reason: expect.stringContaining("live") });
  });

  test("preserves unavailable live evidence and rejects waiving a required check", () => {
    const check = checks[3]!;
    const blocked = { status: "blocked", reason: "Browser unavailable" } as const;
    const waived = { status: "not_applicable", reason: "No browser session" } as const;

    expect(inspectUiVerification(check, { method: "live", evidence: observed(check.criterion.id, { outcome: blocked }) }, sources))
      .toEqual(blocked);
    expect(inspectUiVerification(check, { method: "live", evidence: observed(check.criterion.id, { outcome: waived }) }, sources))
      .toMatchObject({ status: "blocked", reason: expect.stringContaining(waived.reason) });
    const optionalCheck = { ...check, criterion: { ...check.criterion, required: false } };
    expect(inspectUiVerification(optionalCheck, { method: "live", evidence: observed(check.criterion.id, { outcome: waived }) }, sources))
      .toEqual(waived);
  });

  test("blocks stale evidence and an observed pass without a result artifact", () => {
    const check = checks[0]!;
    const staleSource = observed(check.criterion.id, { source: { digest: `sha256:${"f".repeat(64)}` } });
    const stalePolicy = observed(check.criterion.id, { policy: { ...sources.policy, digest: `sha256:${"f".repeat(64)}` } });
    const noArtifacts = observed(check.criterion.id, { artifacts: [] });
    for (const evidence of [staleSource, stalePolicy, noArtifacts]) {
      expect(inspectUiVerification(check, { method: "live", evidence }, sources))
        .toMatchObject({ status: "blocked", reason: expect.any(String) });
    }
  });

  test("does not count observations for a different acceptance criterion", () => {
    expect(inspectUiVerification(checks[2]!, { method: "live", evidence: observed(checks[0]!.criterion.id) }, sources))
      .toMatchObject({ status: "not_run", reason: expect.stringContaining("responsive") });
  });
});
