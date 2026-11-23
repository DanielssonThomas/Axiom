import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluationCaseSchema, taskBriefSchema } from "@axiom/contracts";
import type { TaskBrief } from "@axiom/contracts";
import { expect, test } from "vitest";
import { assessEvidence, captureCommandEvidence, EvidenceStore } from "../../../packages/evidence/src/index.js";
import { resolvePolicy } from "../../../packages/policy/src/index.js";

const repository = new URL("../../../", import.meta.url);
const cases = [
  ["delegate", "retain-worker-requirements"],
  ["knowledge", "update-the-owning-procedure"],
] as const;

function source(path: string) {
  return { path, text: readFileSync(new URL(path, repository), "utf8") };
}

function caseSource(skill: string, id: string) {
  return source(`skills/${skill}/evals/${id}.json`);
}

function fixture(skill: string, id: string): URL {
  const definition = evaluationCaseSchema.parse(JSON.parse(caseSource(skill, id).text));
  return new URL(`${definition.fixture}/`, repository);
}

test.each(cases)("%s uses standard metadata and a schema-valid linked evaluation", (skill, id) => {
  const skillSource = source(`skills/${skill}/SKILL.md`);
  const result = resolvePolicy({
    core: { ...source("core/AXIOMS.md"), version: "1" },
    profiles: [source("profiles/ui-atomic/profile.json")],
    checks: {
      "ui-atomic.composition": { kind: "mechanical" },
      "ui-atomic.reuse": { kind: "mechanical" },
      "ui-atomic.verification": { kind: "mechanical" },
    },
    skills: [skillSource],
    evaluations: [caseSource(skill, id)],
  }, []);
  expect(result.diagnostics).toEqual([]);
  expect(result.policy).toBeDefined();
  expect(skillSource.text).toContain("## When to use");
  expect(readFileSync(new URL("issue.txt", fixture(skill, id)), "utf8")).toBeTruthy();
});

function overlappingOwnership(left: TaskBrief, right: TaskBrief): boolean {
  return left.ownedPaths.some((first) => right.ownedPaths.some((second) =>
    first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`)));
}

test("seeded briefs retain requirements and expose parent-child ownership conflicts", () => {
  const workspace = fixture("delegate", "retain-worker-requirements");
  const brief = taskBriefSchema.parse(JSON.parse(readFileSync(new URL("worker-brief.json", workspace), "utf8")));
  const sibling = taskBriefSchema.parse({ ...brief, id: "sibling", ownedPaths: ["packages/exports"] });
  const overlapping = taskBriefSchema.parse({ ...sibling, ownedPaths: ["packages/filters/src"] });
  expect(brief.parentId).toBe("filter-and-export");
  expect(brief.policy.profiles).toContainEqual({ id: "ui-atomic", version: "1" });
  expect(brief.criteria.find(({ id }) => id === "filter-smoke")?.required).toBe(true);
  expect(taskBriefSchema.safeParse({ ...brief, policy: undefined }).success).toBe(false);
  expect(taskBriefSchema.safeParse({ ...brief, criteria: [] }).success).toBe(false);
  expect(overlappingOwnership(brief, sibling)).toBe(false);
  expect(overlappingOwnership(brief, overlapping)).toBe(true);
});

test("a seeded worker completion claim needs observed evidence for the combined source", async () => {
  const workspace = fixture("delegate", "retain-worker-requirements");
  const brief = taskBriefSchema.parse(JSON.parse(readFileSync(new URL("worker-brief.json", workspace), "utf8")));
  const directory = mkdtempSync(join(tmpdir(), "axiom-delegation-"));
  try {
    const root = join(directory, "combined");
    mkdirSync(root);
    execFileSync("git", ["init", "--quiet", root]);
    const file = join(root, "filter.txt");
    writeFileSync(file, "worker output");
    const scope = { root };
    const store = new EvidenceStore(join(directory, "evidence"));
    const request = {
      id: "worker-result",
      task: brief,
      criterionIds: brief.criteria.map(({ id }) => id),
      source: scope,
      store,
      command: {
        executable: process.execPath,
        args: ["-e", 'const assert = require("node:assert/strict"); assert.equal(require("node:fs").readFileSync("filter.txt", "utf8"), "worker output");'],
        cwd: root,
      },
    };
    const record = await captureCommandEvidence(request, async ({ executable, args, cwd }) => {
      execFileSync(executable, args, { cwd, stdio: "ignore", timeout: 10_000 });
      return { kind: "exited", exitCode: 0 };
    });
    const assessment = () => assessEvidence({
      task: brief, source: scope, store,
      checks: brief.criteria.map(({ id }) => ({ criterionId: id, evidenceIds: [record.id] })),
    });
    expect(record.outcome.status).toBe("passed");
    expect((await assessment()).conforms).toBe(false);
    await store.record("acceptance", record);
    expect((await assessment()).conforms).toBe(true);

    writeFileSync(file, "combined output changed after the worker check");
    const stale = await assessment();
    expect(stale.conforms).toBe(false);
    expect(stale.criteria[0]?.results[0]?.outcome.status).toBe("blocked");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a seeded verified workflow improvement belongs in its existing scoped owner", () => {
  const workspace = fixture("knowledge", "update-the-owning-procedure");
  const guide = readFileSync(new URL("WORKFLOW.md", workspace), "utf8");
  const handoff = readFileSync(new URL("handoff.txt", workspace), "utf8");
  expect(guide).toContain("node --test label.test.mjs");
  expect(handoff).toContain("Timeout hypothesis: not reproduced");

  const expectedCommand = "node --test tests/label.test.mjs";
  const updated = guide.replace("node --test label.test.mjs", expectedCommand);
  const compliant = { "WORKFLOW.md": updated };
  const duplicates = { ...compliant, "WORKAROUND.md": updated };
  const unverified = { "WORKFLOW.md": updated + "\nThe timeout hypothesis is confirmed.\n" };
  const acceptsScopedUpdate = (changes: Record<string, string>) => {
    const workflow = changes["WORKFLOW.md"];
    return Object.keys(changes).length === 1
      && workflow?.includes(expectedCommand) === true
      && !workflow.includes("timeout hypothesis is confirmed");
  };
  expect(handoff).toContain(expectedCommand);
  expect(acceptsScopedUpdate(compliant)).toBe(true);
  expect(acceptsScopedUpdate(duplicates)).toBe(false);
  expect(acceptsScopedUpdate(unverified)).toBe(false);
  expect(acceptsScopedUpdate({ "AXIOMS.md": updated })).toBe(false);
});
