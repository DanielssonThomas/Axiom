import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluationCaseSchema, evidenceSchema } from "@axiom/contracts";
import { expect, test } from "vitest";
import { resolvePolicy } from "../../../packages/policy/src/index.js";
import { inspectUiVerification } from "../../../profiles/ui-atomic/checks.js";
import type { UiCheck } from "../../../profiles/ui-atomic/checks.js";

const repository = new URL("../../../", import.meta.url);
const cases = [
  { skill: "verify", id: "fresh-runtime-evidence" },
  { skill: "diagnose", id: "prevent-missing-label" },
] as const;

function source(path: string) {
  return { path, text: readFileSync(new URL(path, repository), "utf8") };
}

function caseSource(skill: string, id: string) {
  return source(`skills/${skill}/evals/${id}.json`);
}

function readCase(skill: string, id: string) {
  return evaluationCaseSchema.parse(JSON.parse(caseSource(skill, id).text));
}

test.each(cases)("$skill metadata and linked example use the portable contracts", ({ skill, id }) => {
  const skillSource = source(`skills/${skill}/SKILL.md`);
  const resolution = resolvePolicy({
    core: { ...source("core/AXIOMS.md"), version: "1" },
    profiles: [],
    checks: {},
    skills: [skillSource],
    evaluations: [caseSource(skill, id)],
  }, []);
  expect(resolution.diagnostics).toEqual([]);
  expect(resolution.policy).toBeDefined();
  expect(skillSource.text).toContain("## When to use");
  expect(skillSource.text).toContain("## Procedure");
  expect(skillSource.text).toContain("## Expected evidence");

  const definition = readCase(skill, id);
  expect(definition.skill?.id).toBe(skill);
  expect(definition.assertions.every((assertion) => assertion.required)).toBe(true);
  expect(readFileSync(new URL(`${definition.fixture}/issue.txt`, repository), "utf8")).toBeTruthy();
});

test("seeded verification distinguishes fresh native tests, stale results, and missing live evidence", () => {
  const definition = readCase("verify", "fresh-runtime-evidence");
  expect(definition.assertions.map(({ id }) => id)).toEqual([
    "verify-final-revision", "report-live-gap", "demonstrate-behavioral-coverage",
  ]);
  const freshSource = { digest: `sha256:${"f".repeat(64)}` };
  const record = evidenceSchema.parse({
    id: "unit-run",
    taskId: "filter-panel",
    criterionIds: ["filter-rule-unit"],
    policy: { version: "1", digest: `sha256:${"a".repeat(64)}`, profiles: [] },
    source: freshSource,
    provenance: "observed",
    startedAt: "2026-01-01T10:00:00Z",
    durationMs: 100,
    command: { executable: "pnpm", args: ["test"], cwd: "/fixture", exitCode: 0 },
    artifacts: [{ kind: "test-report", location: "unit.json" }],
    outcome: { status: "passed" },
  });
  const stale = evidenceSchema.parse({ ...record, source: { digest: `sha256:${"b".repeat(64)}` } });
  const browser = evidenceSchema.parse({
    ...record,
    id: "browser-check",
    criterionIds: ["filter-panel-interaction"],
    command: undefined,
    outcome: { status: "blocked", reason: "The browser runner is unavailable." },
  });
  const unitCheck: UiCheck = {
    area: "interaction",
    method: "acceptance",
    criterion: { id: "filter-rule-unit", description: "Verify filtering logic", required: true },
  };
  const liveCheck: UiCheck = {
    area: "interaction",
    method: "live",
    criterion: { id: "filter-panel-interaction", description: "Select Active in the running view", required: true },
  };
  const current = { source: freshSource, policy: record.policy };
  expect(inspectUiVerification(unitCheck, { method: "acceptance", evidence: record }, current))
    .toEqual({ status: "passed" });
  expect(inspectUiVerification(unitCheck, { method: "acceptance", evidence: stale }, current).status).toBe("blocked");
  expect(inspectUiVerification(liveCheck, { method: "live", evidence: browser }, current))
    .toEqual({ status: "blocked", reason: "The browser runner is unavailable." });
  expect(inspectUiVerification(liveCheck, undefined, current).status).toBe("not_run");
  expect(inspectUiVerification(liveCheck, { method: "acceptance", evidence: record }, current).status).toBe("not_run");
});

test("seeded diagnosis verifies a regression with the owner and exposes the workaround gap", () => {
  const definition = readCase("diagnose", "prevent-missing-label");
  expect(definition.assertions.map(({ id }) => id)).toEqual([
    "demonstrate-cause", "prevent-in-owner", "avoid-duplicate-guidance",
  ]);

  const directory = mkdtempSync(join(tmpdir(), "axiom-diagnosis-"));
  try {
    cpSync(new URL(`${definition.fixture}/`, repository), directory, { recursive: true });
    const executable = () => execFileSync(process.execPath, ["--test", "label.test.mjs"], {
      cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    });
    const originalFiles = readdirSync(directory);
    const owner = join(directory, "label.mjs");
    const defectiveSource = readFileSync(owner, "utf8");
    const originalTests = readFileSync(join(directory, "label.test.mjs"), "utf8");
    expect(executable()).toContain("pass 1");
    writeFileSync(join(directory, "label.test.mjs"), originalTests + '\ntest("uses the fallback for omitted input", () => assert.equal(label(), "Untitled"));\n');
    expect(executable).toThrow();

    writeFileSync(owner, 'export function label(value = "") { return value.trim() || "Untitled"; }\n');
    expect(executable()).toContain("pass 2");
    expect(readdirSync(directory)).toEqual(originalFiles);

    writeFileSync(owner, defectiveSource);
    const workaround = {
      "retry-wrapper.mjs": 'export const retryLabel = (label, value) => { try { return label(value); } catch { return "Untitled"; } };',
      "WORKAROUND.md": "Use the retry wrapper when a label is missing.",
    };
    for (const [path, contents] of Object.entries(workaround)) writeFileSync(join(directory, path), contents);
    expect(executable).toThrow();

    expect(readdirSync(directory).filter((path) => !originalFiles.includes(path))).toEqual(["WORKAROUND.md", "retry-wrapper.mjs"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
