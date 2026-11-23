import { existsSync, readFileSync } from "node:fs";
import { evaluationCaseSchema, profileDefinitionSchema } from "@axiom/contracts";
import { expect, test } from "vitest";
import { inspectAngularWorkspace } from "../../../profiles/angular-nx/checks.js";
import type { AngularWorkspace } from "../../../profiles/angular-nx/checks.js";

const featureRoot = "libs/catalog/src/lib";
const page = `${featureRoot}/pages/dashboard/dashboard.component.ts`;
const collection = `${featureRoot}/collections/results/results.component.ts`;
const model = `${featureRoot}/models/catalog.model.ts`;
const atom = `${featureRoot}/atoms/result-label-atom.component.ts`;
const molecule = `${featureRoot}/molecules/result-row-molecule.component.ts`;
const organism = `${featureRoot}/organisms/results-panel-organism.component.ts`;
const template = `${featureRoot}/templates/catalog-layout-template.component.ts`;
const publicApi = "libs/catalog/src/index.ts";
const main = "apps/catalog-web/src/main.ts";

function component(name: string, properties: string, imports = "") {
  return `
import { Component } from "@angular/core";
${imports}
@Component({ ${properties} })
export class ${name} {}
`;
}

const files: Record<string, string> = {
  [main]: 'import { DashboardComponent } from "@fixture/catalog"; export const view = DashboardComponent;',
  [page]: component("DashboardComponent", 'templateUrl: "./dashboard.component.html"') +
    "type SortState = 'name' | 'rank';",
  [page.replace(".ts", ".html")]: "<h1>Catalog</h1>",
  [page.replace(".ts", ".spec.ts")]: "export {};",
  [collection]: component("ResultsComponent", 'templateUrl: "./results.component.html"'),
  [collection.replace(".ts", ".html")]: "<ul></ul>",
  [model]: `
export interface CatalogModel { title: string }
export interface DashboardInput { query: string }
export interface DashboardOutput { selected: string }
export interface DashboardViewModel { label: string }
`,
  [publicApi]: 'export { DashboardComponent } from "./lib/pages/dashboard/dashboard.component";',
  [atom]: component("ResultLabelAtomComponent", 'template: "{{ label }}"'),
  [molecule]: component("ResultRowMoleculeComponent", 'template: "", imports: [ResultLabelAtomComponent]',
    'import { ResultLabelAtomComponent } from "../atoms/result-label-atom.component";'),
  [organism]: component("ResultsPanelOrganismComponent", 'template: "", imports: [ResultRowMoleculeComponent]',
    'import { ResultRowMoleculeComponent } from "../molecules/result-row-molecule.component";'),
  [template]: component("CatalogLayoutTemplateComponent", 'template: "", imports: [ResultsPanelOrganismComponent]',
    'import { ResultsPanelOrganismComponent } from "../organisms/results-panel-organism.component";'),
};

const workspace: AngularWorkspace = {
  files,
  projects: [
    { kind: "application", name: "catalog-web", sourceRoot: "apps/catalog-web/src", shellFiles: [main] },
    { kind: "library", name: "catalog", sourceRoot: "libs/catalog/src", publicApi },
  ],
  paths: { "@fixture/catalog": [`./${publicApi}`] },
  models: ["CatalogModel", "DashboardInput", "DashboardOutput", "DashboardViewModel"]
    .map((name) => ({ name, project: "catalog", scope: featureRoot, visibility: "owner" })),
};

function inspect(changed: Record<string, string>) {
  return inspectAngularWorkspace({ ...workspace, files: { ...files, ...changed } });
}

test("extends the shared optional atomic UI profile and declares only Angular checks", () => {
  const profile = profileDefinitionSchema.parse(JSON.parse(readFileSync(
    new URL("../../../profiles/angular-nx/profile.json", import.meta.url), "utf8",
  )));
  expect(profile.extends).toEqual(["ui-atomic"]);
  expect(profile.checks.length).toBeGreaterThan(0);
  expect(profile.checks.every(({ id }) => id.startsWith("angular-nx."))).toBe(true);

  const evaluation = evaluationCaseSchema.parse(JSON.parse(readFileSync(
    new URL("../../../profiles/angular-nx/evals/workspace.json", import.meta.url), "utf8",
  )));
  expect(evaluation.profiles).toContainEqual({ id: profile.id, version: profile.version });
  expect(existsSync(new URL(`../../../${evaluation.fixture}/angular.json`, import.meta.url))).toBe(true);
  expect(evaluation.assertions.every(({ grader }) => profile.checks.some(({ id }) => id === grader))).toBe(true);
});

test("accepts scoped components, a thin shell and local private implementation types", () => {
  expect(inspectAngularWorkspace(workspace)).toEqual([]);
});

test.each([page, collection])("rejects an external template outside the owning directory of %s", (path) => {
  const content = files[path]!.replace("templateUrl: \"./", "templateUrl: \"../");
  expect(inspect({ [path]: content })).toContainEqual(expect.objectContaining({ code: "split-component", path }));
});

test("rejects pages outside their own directory and related tests outside the owner", () => {
  const flat = `${featureRoot}/pages/dashboard.component.ts`;
  expect(inspect({
    [flat]: files[page]!,
    [`${featureRoot}/pages/unrelated/dashboard.component.spec.ts`]: "export {};",
  })).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "component-directory", path: flat }),
    expect.objectContaining({ code: "split-component", path: page }),
  ]));
});

test("rejects feature code in an application shell and imports that bypass a library API", () => {
  const featureInApp = "apps/catalog-web/src/product-details.component.ts";
  expect(inspect({
    [featureInApp]: component("DetailsComponent", 'template: ""'),
    [main]: 'import { DashboardComponent } from "../../../libs/catalog/src/lib/pages/dashboard/dashboard.component";',
  })).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "application-feature", path: featureInApp }),
    expect.objectContaining({ code: "private-library-import", path: main }),
  ]));
});

test("reports unowned source and library roots without their declared public API", () => {
  const unmanaged = "libs/reports/src/catalog.ts";
  expect(inspectAngularWorkspace({
    ...workspace,
    files: { ...files, [unmanaged]: "export const report = 'Catalog';" },
    projects: [...workspace.projects, {
      kind: "library", name: "orders", sourceRoot: "libs/orders/src", publicApi: "libs/orders/src/index.ts",
    }],
  })).toEqual(expect.arrayContaining([
    { code: "unscoped-source", path: unmanaged },
    { code: "missing-library-api", path: "libs/orders/src/index.ts" },
  ]));
});

test("reuses atomic dependency validation and checks Angular suffixes", () => {
  const incorrectSuffix = `${featureRoot}/atoms/label.component.ts`;
  expect(inspect({
    [incorrectSuffix]: component("LabelComponent", 'template: ""'),
    [atom]: component("ResultLabelAtomComponent", 'template: "", imports:[ResultsPanelOrganismComponent]',
      'import { ResultsPanelOrganismComponent } from "../organisms/results-panel-organism.component";'),
  })).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "atomic-suffix", path: incorrectSuffix }),
    expect.objectContaining({ code: "non-downward-dependency", path: atom, dependency: organism }),
  ]));
});

test("rejects a named model kept in a component, copied contracts, and exposure of feature-private types", () => {
  expect(inspect({
    [model]: files[model]!.replace(/export interface DashboardInput[^\n]+\n/, ""),
    [page]: files[page]! + "\ninterface DashboardInput { query: string }\ninterface CatalogModel { title: string }",
    [publicApi]: files[publicApi]! + '\nexport * from "./lib/models/catalog.model";',
  })).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "model-owner", path: page, model: "DashboardInput" }),
    expect.objectContaining({ code: "duplicate-model", model: "CatalogModel" }),
    expect.objectContaining({ code: "private-model-export", path: publicApi, model: "DashboardViewModel" }),
  ]));
});
