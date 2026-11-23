import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { evaluationCaseSchema } from "@axiom/contracts";

const repository = new URL("../../../", import.meta.url);

function readCase(skill: string, id: string) {
  const path = new URL(`skills/${skill}/evals/${id}.json`, repository);
  return evaluationCaseSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

describe("portable skill assets", () => {
  test.each(["context", "design"])("%s has Agent Skills metadata and colocated cases", (skill) => {
    const directory = new URL(`skills/${skill}/`, repository);
    const source = readFileSync(new URL("SKILL.md", directory), "utf8");
    const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/.exec(source);
    const metadata: unknown = parse(frontmatter?.[1] ?? "");
    expect(metadata).toEqual({
      name: skill,
      description: expect.stringMatching(/^.{1,1024}$/),
    });
    for (const heading of ["When to use", "Procedure", "Expected evidence"]) {
      expect(source).toContain(`## ${heading}`);
    }

    const cases = readdirSync(new URL("evals/", directory)).filter((name) => name.endsWith(".json"));
    expect(cases.length).toBeGreaterThan(0);
    for (const name of cases) {
      const evaluation = readCase(skill, name.slice(0, -5));
      expect(evaluation.id).toBe(name.slice(0, -5));
      expect(evaluation.skill?.id).toBe(skill);
      expect(evaluation.profiles).toEqual([]);
      expect(evaluation.fixture.startsWith(`skills/${skill}/evals/fixtures/`)).toBe(true);
      expect(statSync(new URL(evaluation.fixture, repository)).isDirectory()).toBe(true);
      expect(evaluation.assertions.every((assertion) => assertion.required)).toBe(true);
    }
  });
});

type ContextAction =
  | { kind: "read"; path: string }
  | { kind: "ask"; topic: string }
  | { kind: "edit"; path: string };

function discoveredBeforeEdit(actions: ContextAction[], requiredReads: string[]) {
  const firstEdit = actions.findIndex((action) => action.kind === "edit");
  const beforeEdit = actions.slice(0, firstEdit);
  return firstEdit >= 0
    && requiredReads.every((path) => beforeEdit.some((action) => action.kind === "read" && action.path === path))
    && !actions.some((action) => action.kind === "ask");
}

function asksForMaterialDecision(actions: ContextAction[]) {
  const question = actions.findIndex((action) => action.kind === "ask" && action.topic === "target audience");
  return question >= 0 && actions.slice(0, question).some((action) => action.kind === "read" && action.path === "issue.txt")
    && !actions.some((action) => action.kind === "edit");
}

describe("seeded context outcomes", () => {
  test("recognizes relevant instructions, the issue, docs, and existing tools before an edit", () => {
    const evaluation = readCase("context", "inspect-repository");
    const fixture = new URL(`${evaluation.fixture}/`, repository);
    const paths = ["AGENTS.md", "src/AGENTS.md", "README.md", "issue.txt", "package.json"];
    expect(evaluation.assertions.map(({ id }) => id)).toContain("inspect-before-edit");
    expect(paths.every((path) => existsSync(new URL(path, fixture)))).toBe(true);
    const reads: ContextAction[] = paths.map((path) => ({ kind: "read", path }));
    const edit: ContextAction = { kind: "edit", path: "src/summary.mjs" };

    expect(discoveredBeforeEdit([...reads, edit], paths)).toBe(true);
    expect(discoveredBeforeEdit([edit, ...reads], paths)).toBe(false);
    expect(discoveredBeforeEdit([...reads.filter((action) => action.kind !== "read" || action.path !== "src/AGENTS.md"), edit], paths)).toBe(false);
    expect(discoveredBeforeEdit([...reads, { kind: "ask", topic: "settled output format" }, edit], paths)).toBe(false);
  });

  test("distinguishes a focused material question from a guess followed by an edit", () => {
    const evaluation = readCase("context", "clarify-material-decision");
    const fixture = new URL(`${evaluation.fixture}/`, repository);
    expect(evaluation.assertions.map(({ id }) => id)).toContain("clarify-before-edit");
    expect(readFileSync(new URL("issue.txt", fixture), "utf8")).toContain("audience");
    const read: ContextAction = { kind: "read", path: "issue.txt" };
    const question: ContextAction = { kind: "ask", topic: "target audience" };
    const edit: ContextAction = { kind: "edit", path: "summary.mjs" };

    expect(asksForMaterialDecision([read, question])).toBe(true);
    expect(asksForMaterialDecision([read, edit, question])).toBe(false);
    expect(asksForMaterialDecision([question, read])).toBe(false);
    expect(asksForMaterialDecision([read, { kind: "ask", topic: "variable name" }])).toBe(false);
  });
});

describe("seeded design outcomes", () => {
  test("recognizes existing API reuse and rejects unnecessary one-call module chains", () => {
    const evaluation = readCase("design", "reuse-summary-formatter");
    const fixture = new URL(`${evaluation.fixture}/`, repository);
    expect(evaluation.assertions.map(({ id }) => id)).toEqual(["reuse-formatter", "keep-command-cohesive"]);
    expect(readFileSync(new URL("summary-format.mjs", fixture), "utf8")).toContain("export function formatSummary");

    const compliant = {
      "command.mjs": 'import { formatSummary } from "./summary-format.mjs";\nexport const run = (rows) => formatSummary(rows);',
    };
    const duplicate = {
      "command.mjs": 'export const run = (rows) => rows.map((row) => `- ${row.label}`).join("\\n");',
    };
    const fragmented = {
      ...compliant,
      "format-forwarder.mjs": 'export { formatSummary as format } from "./summary-format.mjs";',
      "command-wrapper.mjs": 'export { run as invoke } from "./command.mjs";',
    };

    const originalFormatter = readFileSync(new URL("summary-format.mjs", fixture), "utf8");
    const updatedFormatter = 'export const formatSummary = (rows) => rows.map((row) => row.label.toUpperCase()).join(", ");';
    expect(runSeededCommand(compliant, originalFormatter)).toBe("- amd");
    expect(runSeededCommand(duplicate, originalFormatter)).toBe("- amd");
    expect(runSeededCommand(compliant, updatedFormatter)).toBe("AMD");
    expect(runSeededCommand(duplicate, updatedFormatter)).toBe("- amd");
    expect(runSeededCommand(fragmented, updatedFormatter)).toBe("AMD");
    expect(Object.keys(compliant)).toEqual(["command.mjs"]);
    expect(Object.keys(fragmented)).not.toEqual(["command.mjs"]);
  });
});

function runSeededCommand(changes: Record<string, string>, formatter: string) {
  const directory = mkdtempSync(join(tmpdir(), "axiom-design-fixture-"));
  try {
    writeFileSync(join(directory, "summary-format.mjs"), formatter);
    for (const [path, content] of Object.entries(changes)) {
      writeFileSync(join(directory, path), content);
    }
    return execFileSync(process.execPath, [
      "--input-type=module", "--eval",
      'import { run } from "./command.mjs"; process.stdout.write(run([{ label: "amd" }]));',
    ], { cwd: directory, encoding: "utf8", timeout: 10_000 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
