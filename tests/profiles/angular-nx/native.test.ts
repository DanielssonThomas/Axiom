import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { inspectAngularWorkspace } from "../../../profiles/angular-nx/checks.js";
import { generateAngularComponent } from "../../../profiles/angular-nx/generator.js";

const fixture = fileURLToPath(new URL(
  "../../../profiles/angular-nx/evals/fixtures/angular-workspace/", import.meta.url,
));
const nativeModules = process.env.AXIOM_ANGULAR_FIXTURE_MODULES;

test.runIf(nativeModules)("generates and verifies the installed Angular/Nx fixture", () => {
  const workspace = mkdtempSync(join(tmpdir(), "axiom-native-angular-"));
  try {
    cpSync(fixture, workspace, {
      recursive: true,
      filter: (file) => !["node_modules", "dist", ".angular", ".nx"].includes(basename(file)),
    });
    symlinkSync(resolve(nativeModules!), join(workspace, "node_modules"), "junction");

    const page = { project: "catalog", directory: "libs/catalog/src/lib/pages", name: "dashboard" };
    const collection = { project: "catalog", directory: "libs/catalog/src/lib/collections", name: "results" };
    for (const request of [page, collection]) {
      const generated = generateAngularComponent(workspace, request);
      expect(generated, JSON.stringify(generated)).toEqual({ status: "passed" });
      const path = join(workspace, request.directory, request.name, request.name + ".component");
      expect(existsSync(path + ".ts")).toBe(true);
      expect(existsSync(path + ".spec.ts")).toBe(true);
      const template = readFileSync(path + ".html", "utf8");
      expect(template).toContain(request.name);
      expect(generateAngularComponent(workspace, request)).toMatchObject({
        status: "blocked", reason: expect.stringContaining("already exists"),
      });
      expect(readFileSync(path + ".html", "utf8")).toBe(template);
    }

    const projectRoots = ["apps/catalog-web/src", "libs/catalog/src"];
    const files = Object.fromEntries(projectRoots.flatMap((root) =>
      readdirSync(join(workspace, root), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile()).map((entry) => {
          const path = join(entry.parentPath, entry.name);
          return [relative(workspace, path).split(sep).join("/"), readFileSync(path, "utf8")];
        })
    ));
    const typescript = JSON.parse(readFileSync(join(workspace, "tsconfig.json"), "utf8"));
    expect(inspectAngularWorkspace({
      files,
      paths: typescript.compilerOptions.paths,
      projects: [
        { kind: "application", name: "catalog-web", sourceRoot: "apps/catalog-web/src", shellFiles: ["apps/catalog-web/src/main.ts"] },
        { kind: "library", name: "catalog", sourceRoot: "libs/catalog/src", publicApi: "libs/catalog/src/index.ts" },
      ],
      models: [{ name: "CatalogDisplay", project: "catalog", scope: "libs/catalog/src/lib", visibility: "public" }],
    })).toEqual([]);

    const modules = join(workspace, "node_modules");
    const nx = JSON.parse(readFileSync(join(modules, "nx", "package.json"), "utf8"));
    const env = {
      ...process.env,
      PATH: [join(modules, ".bin"), process.env.PATH].join(delimiter),
      CI: "true",
      NX_DAEMON: "false",
      NX_TASKS_RUNNER_DYNAMIC_OUTPUT: "false",
      NG_CLI_ANALYTICS: "false",
    };
    for (const target of ["build", "test", "lint"]) {
      const result = spawnSync(process.execPath, [
        join(modules, "nx", nx.bin.nx), "run", `catalog-web:${target}`, "--skip-nx-cache",
      ], {
        cwd: workspace, encoding: "utf8", timeout: 90_000,
        env,
      });
      expect(result.error, target).toBeUndefined();
      expect(result.status, `${target}\n${result.stdout}\n${result.stderr}`).toBe(0);
      if (target === "test") expect(result.stdout).toMatch(/Tests\s+2 passed/);
    }
    expect(existsSync(join(workspace, "dist", "catalog-web", "browser", "index.html"))).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}, 180_000);
