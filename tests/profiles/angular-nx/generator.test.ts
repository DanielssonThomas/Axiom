import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { generateAngularComponent } from "../../../profiles/angular-nx/generator.js";

const project = "catalog";
const directory = "libs/catalog/src/lib/pages";
const request = { project, directory, name: "dashboard" };

function workspaceFor(version: string) {
  const workspace = mkdtempSync(join(tmpdir(), "axiom-angular-profile-"));
  for (const name of ["@angular/cli", "@schematics/angular"]) {
    const packageDirectory = join(workspace, "node_modules", name);
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name, version, bin: { ng: "ng.cjs" } }));
    writeFileSync(join(packageDirectory, "ng.cjs"),
      'require("node:fs").writeFileSync("unexpected-mutation", "the generator was invoked");');
  }
  writeFileSync(join(workspace, "angular.json"), JSON.stringify({
    projects: { catalog: { projectType: "library", sourceRoot: "libs/catalog/src" } },
  }));
  return workspace;
}

test("rejects an unsupported installed generator before it can mutate files", () => {
  const workspace = workspaceFor("20.3.0");
  try {
    expect(generateAngularComponent(workspace, request)).toMatchObject({
      status: "blocked", reason: expect.stringContaining("20.3.0"),
    });
    expect(existsSync(join(workspace, "unexpected-mutation"))).toBe(false);
    expect(existsSync(join(workspace, directory, request.name))).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports a collision before invoking generation and preserves existing work", () => {
  const workspace = workspaceFor("21.2.26");
  try {
    const target = join(workspace, directory, request.name);
    mkdirSync(target, { recursive: true });
    const existing = join(target, "dashboard.component.html");
    writeFileSync(existing, "<h1>Existing dashboard</h1>");
    expect(generateAngularComponent(workspace, request)).toMatchObject({
      status: "blocked", reason: expect.stringContaining("already exists"),
    });
    expect(readFileSync(existing, "utf8")).toBe("<h1>Existing dashboard</h1>");
    expect(existsSync(join(workspace, "unexpected-mutation"))).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
