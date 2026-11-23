import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { profileDefinitionSchema } from "@axiom/contracts";
import { fixtureAdapters } from "./fixtures.js";
import { assembleBundles, loadBundleWorkspace, writeBundles } from "./index.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const workspacePackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const { catalog, skills } = loadBundleWorkspace(repository);
const selectedProfiles = catalog.profiles.map(({ text }) => profileDefinitionSchema.parse(JSON.parse(text)).id);
const artifacts = assembleBundles(repository, {
  version: workspacePackage.version,
  sourceRevision: process.env.AXIOM_BUNDLE_SOURCE_REVISION ?? sourceRevision(),
  policyVersion: catalog.core.version,
  selectedProfiles,
  skills,
  checks: catalog.checks,
  adapters: fixtureAdapters,
});
for (const { directory, manifest } of writeBundles(join(repository, "packages/bundles/dist/fixtures"), artifacts)) {
  console.log(`${manifest.host} fixture: ${directory}`);
}

function sourceRevision(): string {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "source-archive";
  }
}
