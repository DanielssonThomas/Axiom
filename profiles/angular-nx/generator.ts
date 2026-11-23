import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { EvidenceOutcome } from "@axiom/contracts";

interface GeneratorRequest {
  project: string;
  directory: string;
  name: string;
}

interface InstalledPackage {
  path: string;
  version: string;
  bin?: { ng?: string };
}

function inDirectory(directory: string, file: string) {
  const distance = relative(directory, file);
  return distance !== ".." && !distance.startsWith(".." + sep) && !isAbsolute(distance);
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Generate a standalone component using the installed Angular 21 schematic in the selected repository. */
export function generateAngularComponent(workspace: string, request: GeneratorRequest): EvidenceOutcome {
  let cli: InstalledPackage;
  let schematics: InstalledPackage;
  let sourceRoot: string;
  try {
    workspace = realpathSync(workspace);
    const require = createRequire(resolve(workspace, "package.json"));
    function installed(name: string): InstalledPackage {
      const path = require.resolve(name + "/package.json");
      const manifest = readJson(path);
      return { path, version: manifest.version, bin: manifest.bin };
    }
    cli = installed("@angular/cli");
    schematics = installed("@schematics/angular");

    const metadata = readJson(resolve(workspace, "angular.json"));
    const collections: unknown = metadata.cli?.schematicCollections;
    if (Array.isArray(collections) && collections.length > 0 && collections[0] !== "@schematics/angular") {
      return { status: "blocked", reason: "Use the workspace's configured schematic collection." };
    }
    const root: unknown = metadata.projects?.[request.project]?.sourceRoot;
    if (typeof root !== "string" || root.length === 0) {
      return { status: "blocked", reason: `Missing source root for Angular project ${request.project}.` };
    }
    sourceRoot = resolve(workspace, root);
  } catch {
    return { status: "blocked", reason: "Angular workspace configuration or installed CLI/schematics could not be loaded." };
  }

  const supported = /^21\.\d+\.\d+$/;
  if (!supported.test(cli.version) || !supported.test(schematics.version) || cli.version !== schematics.version || !cli.bin?.ng) {
    return { status: "blocked", reason: `Use matching Angular 21 CLI and schematics. Found CLI ${cli.version} and schematics ${schematics.version}.` };
  }
  const directory = resolve(workspace, request.directory);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(request.name)
    || !inDirectory(workspace, sourceRoot) || !inDirectory(sourceRoot, directory)) {
    return { status: "blocked", reason: "Select a safe component name and a directory under the configured project source root." };
  }

  // Reject a symlinked existing prefix that redirects the generator outside the source root.
  let existing = directory;
  while (!existsSync(existing)) existing = dirname(existing);
  try {
    const realRoot = realpathSync(sourceRoot);
    if (!inDirectory(workspace, realRoot) || !inDirectory(realRoot, realpathSync(existing))) {
      return { status: "blocked", reason: "The generation directory resolves outside the configured project source root." };
    }
  } catch {
    return { status: "blocked", reason: "The configured project source root could not be resolved." };
  }
  if (existsSync(resolve(directory, request.name))) {
    return { status: "blocked", reason: `A component directory named ${request.name} already exists in ${request.directory}.` };
  }
  const result = spawnSync(process.execPath, [
    resolve(dirname(cli.path), cli.bin.ng), "generate", "@schematics/angular:component", request.name,
    "--project", request.project, "--path", relative(workspace, directory).split(sep).join("/"),
    "--flat=false", "--inline-template=false", "--ng-html=false", "--standalone=true",
    "--type=component", "--add-type-to-class-name=true", "--skip-tests=false",
    "--export-default=false", "--interactive=false",
  ], { cwd: workspace, encoding: "utf8", timeout: 60_000 });
  if (result.status === 0) return { status: "passed" };

  const error = result.error?.message ?? result.stderr.trim();
  return { status: "failed", reason: error || `Native generation exited with ${result.status ?? result.signal}.` };
}
