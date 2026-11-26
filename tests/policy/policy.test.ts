import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { policyIdentitySchema } from "@axiom/contracts";
import { assessPolicy, resolvePolicy } from "../../packages/policy/src/index.js";

const core = {
  path: "core/AXIOMS.md",
  text: readFileSync(new URL("../../core/AXIOMS.md", import.meta.url), "utf8"),
  version: "1",
};

const checks = {
  "verify.source": { kind: "mechanical", corePrincipleIds: ["AX-04"] },
  "verify.behavior": { kind: "behavioral", corePrincipleIds: ["AX-05"] },
  "ui.composition": { kind: "mechanical" },
  "ui.optional": { kind: "mechanical" },
} as const;

function json(path: string, value: unknown) {
  return { path, text: JSON.stringify(value) };
}

const uiPath = "profiles/ui-atomic/profile.json";
const featurePath = "profiles/fixture-profile/profile.json";
const ui = {
  id: "ui-atomic",
  version: "1",
  extends: [],
  principleIds: ["AX-03", "AX-04"],
  checks: [
    { id: "ui.composition", required: true, principleIds: ["AX-03"] },
    { id: "ui.optional", required: false, principleIds: ["AX-04"] },
  ],
};
const feature = {
  id: "fixture-profile",
  version: "2",
  extends: ["ui-atomic"],
  principleIds: ["AX-03"],
  checks: [{ id: "ui.composition", required: true, principleIds: ["AX-03"] }],
};
const catalog = {
  core,
  profiles: [json(uiPath, ui), json(featurePath, feature)],
  checks,
};

const skillPath = "skills/context/SKILL.md";
const skill = {
  path: skillPath,
  text: "---\nname: context\ndescription: |\n  Inspect task context before changing code.\n---\n\n# Context\n",
};
const casePath = "skills/context/evals/context-discovery.json";
const evaluation = {
  id: "context-discovery",
  version: "1",
  skill: { id: "context", version: "1" },
  profiles: [{ id: "ui-atomic", version: "1" }],
  fixture: "fixtures/repo",
  prompt: "Discover the repository conventions.",
  principleIds: ["AX-01"],
  requiredCapabilities: [],
  assertions: [{ id: "find-conventions", description: "Find the repository rules", grader: "rules-read", required: true }],
};

describe("policy resolution", () => {
  test("reads the canonical core headings and retains source and version without copying rule text", () => {
    const resolution = resolvePolicy(catalog, []);
    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.policy?.principles).toEqual(
      ["AX-01", "AX-02", "AX-03", "AX-04", "AX-05", "AX-06", "AX-07", "AX-08"]
        .map((id) => ({ id, version: "1", source: core.path })),
    );
    expect(policyIdentitySchema.safeParse(resolution.policy?.identity).success).toBe(true);
  });

  test("composes inherited requirements with provenance independent of input order", () => {
    const inherited = resolvePolicy(catalog, ["fixture-profile"]);
    const reversed = resolvePolicy({ ...catalog, profiles: [...catalog.profiles].reverse() }, ["ui-atomic", "fixture-profile"]);

    expect(inherited).toEqual(reversed);
    expect(inherited.diagnostics).toEqual([]);
    expect(inherited.policy?.identity.profiles).toEqual([
      { id: "fixture-profile", version: "2" }, { id: "ui-atomic", version: "1" },
    ]);
    expect(inherited.policy?.requirements.find(({ id }) => id === "ui.composition")).toEqual({
      id: "ui.composition", kind: "mechanical", required: true, principleIds: ["AX-03"],
      origins: [
        { kind: "profile", id: "fixture-profile", path: featurePath },
        { kind: "profile", id: "ui-atomic", path: uiPath },
      ],
    });
    expect(inherited.policy?.requirements.find(({ id }) => id === "verify.source")?.origins).toEqual([
      { kind: "core", path: core.path },
    ]);
  });

  test("changes policy identity when canonical text changes and ignores line-ending differences", () => {
    const result = resolvePolicy(catalog, ["ui-atomic"]);
    const rewritten = (text: string) => resolvePolicy({ ...catalog, core: { ...core, text } }, ["ui-atomic"]);
    expect(result.policy?.identity.digest).toBeDefined();
    expect(rewritten(core.text.replaceAll("\n", "\r\n")).policy?.identity.digest).toBe(result.policy?.identity.digest);
    expect(rewritten(core.text + "\nAn added rule.\n").policy?.identity.digest).not.toBe(result.policy?.identity.digest);
  });

  test("rejects incompatible active requirements and attempts to weaken a core check", () => {
    const conflict = resolvePolicy({
      ...catalog,
      profiles: [json(uiPath, ui), json(featurePath, {
        ...feature, checks: [{ id: "ui.composition", required: false, principleIds: ["AX-03"] }],
      })],
    }, ["fixture-profile"]);
    expect(conflict.diagnostics).toContainEqual(expect.objectContaining({ code: "incompatible_requirement", path: featurePath, field: "checks.0" }));
    expect(assessPolicy(conflict, []).outcome.status).toBe("blocked");

    const weaker = resolvePolicy({
      ...catalog,
      profiles: [json(uiPath, {
        ...ui, checks: [{ id: "verify.source", required: false, principleIds: ["AX-04"] }],
      })],
    }, ["ui-atomic"]);
    expect(weaker.diagnostics).toContainEqual(expect.objectContaining({ code: "core_weakening", path: uiPath, field: "checks.0" }));
    expect(assessPolicy(weaker, []).outcome.status).toBe("failed");
  });

  test.each(["host", "user"] as const)("leaves %s authority in force and blocks conflicting conformance", (authority) => {
    const reason = "The effective instructions prohibit launching the test command.";
    const result = resolvePolicy(catalog, [], [{ authority, path: "AGENTS.md", reason }]);
    expect(result.policy?.principles).toHaveLength(8);
    expect(result.diagnostics).toEqual([{ code: "instruction_conflict", path: "AGENTS.md", field: authority, message: reason }]);
    expect(assessPolicy(result, [
      { id: "verify.source", kind: "mechanical", outcome: { status: "passed" } },
      { id: "verify.behavior", kind: "behavioral", outcome: { status: "passed" } },
    ]).outcome.status).toBe("blocked");
  });
});

describe("structural validation", () => {
  test("accepts Agent Skills frontmatter with a schema-valid sibling evaluation", () => {
    expect(resolvePolicy({ ...catalog, skills: [skill], evaluations: [json(casePath, evaluation)] }, []).diagnostics).toEqual([]);
  });

  test("rejects duplicate case identifiers at a stable path regardless of input order", () => {
    const sharedPath = "evals/cases/context-discovery.json";
    const evaluations = [json(casePath, evaluation), json(sharedPath, { ...evaluation, skill: undefined })];
    const resolve = (sources: typeof evaluations) => resolvePolicy({ ...catalog, skills: [skill], evaluations: sources }, []);
    const resolution = resolve(evaluations);

    expect(resolution.diagnostics).toEqual([{
      code: "duplicate_id",
      path: casePath,
      field: "id",
      message: `Evaluation ${evaluation.id} is already defined at ${sharedPath}.`,
    }]);
    expect(resolution.policy).toBeUndefined();
    expect(resolve([...evaluations].reverse())).toEqual(resolution);
  });

  test("reports invalid document fields, unknown IDs, and missing valid evaluation links", () => {
    const unknownProfilePath = "profiles/malformed/profile.json";
    const invalidJsonPath = "profiles/invalid/profile.json";
    const unlinkedSkillPath = "skills/design/SKILL.md";
    const result = resolvePolicy({
      ...catalog,
      profiles: [
        json(uiPath, {
          ...ui,
          extends: ["missing"],
          principleIds: ["AX-99"],
          checks: [{ id: "unknown", required: true, principleIds: ["AX-03"] }],
        }),
        json(unknownProfilePath, { ...feature, version: 4 }),
        { path: invalidJsonPath, text: "{" },
      ],
      skills: [
        skill,
        { path: unlinkedSkillPath, text: "---\nname: a-different-skill\ndescription: 42\n---\n" },
      ],
      evaluations: [
        json(casePath, {
          ...evaluation, skill: { id: "other", version: "1" }, profiles: [{ id: "missing", version: "1" }],
        }),
      ],
    }, ["missing-selected"]);
    expect(result.diagnostics.map(({ code, path, field }) => [code, path, field])).toEqual([
      ["malformed_definition", invalidJsonPath, ""],
      ["malformed_definition", unknownProfilePath, "version"],
      ["unknown_check", uiPath, "checks.0.id"],
      ["missing_reference", uiPath, "extends.0"],
      ["unknown_principle", uiPath, "principleIds.0"],
      ["missing_reference", "selection", "profiles.0"],
      ["missing_evaluation", skillPath, "evals"],
      ["missing_reference", casePath, "profiles.0.id"],
      ["missing_reference", casePath, "skill.id"],
      ["invalid_skill_metadata", unlinkedSkillPath, "description"],
      ["invalid_skill_metadata", unlinkedSkillPath, "name"],
    ]);
    expect(assessPolicy(result, []).outcome.status).toBe("failed");
  });

  test("detects profile cycles deterministically at the closing reference", () => {
    const cyclic = resolvePolicy({
      ...catalog, profiles: [json(uiPath, { ...ui, extends: ["fixture-profile"] }), json(featurePath, feature)],
    }, ["fixture-profile"]);
    expect(cyclic.diagnostics).toEqual([
      expect.objectContaining({
        code: "profile_cycle", path: uiPath, field: "extends.0",
        message: expect.stringContaining("fixture-profile -> ui-atomic -> fixture-profile"),
      }),
    ]);
  });
});

describe("policy conformance", () => {
  test("keeps observed mechanical checks distinct from missing or mismatched behavioral outcomes", () => {
    const result = resolvePolicy(catalog, []);
    expect(assessPolicy(result, [
      { id: "verify.source", kind: "mechanical", outcome: { status: "passed" } },
    ])).toMatchObject({
      outcome: { status: "not_run" },
      checks: [
        { id: "verify.behavior", kind: "behavioral", outcome: { status: "not_run" } },
        { id: "verify.source", kind: "mechanical", outcome: { status: "passed" } },
      ],
    });
    expect(assessPolicy(result, [
      { id: "verify.source", kind: "mechanical", outcome: { status: "passed" } },
      { id: "verify.behavior", kind: "mechanical", outcome: { status: "passed" } },
    ]).outcome.status).toBe("failed");
  });

  test("retains mandatory failures and rejects a required not_applicable result", () => {
    const result = resolvePolicy(catalog, ["ui-atomic"]);
    const successfulChecks = [
      { id: "verify.source", kind: "mechanical", outcome: { status: "passed" } },
      { id: "ui.composition", kind: "mechanical", outcome: { status: "passed" } },
      { id: "ui.optional", kind: "mechanical", outcome: { status: "passed" } },
    ] as const;
    const failed = assessPolicy(result, [
      ...successfulChecks,
      { id: "verify.behavior", kind: "behavioral", outcome: { status: "failed", reason: "The fixture assertion failed." } },
    ]);
    expect(failed.outcome.status).toBe("failed");
    expect(failed.checks.find(({ id }) => id === "verify.behavior")?.outcome).toEqual({
      status: "failed", reason: "The fixture assertion failed.",
    });
    expect(assessPolicy(result, [
      ...successfulChecks,
      { id: "verify.behavior", kind: "behavioral", outcome: { status: "not_applicable", reason: "Skipped." } },
    ]).outcome.status).toBe("failed");
    expect(assessPolicy(result, [
      ...successfulChecks,
      { id: "verify.behavior", kind: "behavioral", outcome: { status: "passed" } },
    ]).outcome.status).toBe("passed");
  });
});
