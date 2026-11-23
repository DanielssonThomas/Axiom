import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { profileDefinitionSchema } from "@axiom/contracts";
import { fixtureAdapters } from "./fixtures.js";
import { assembleBundles, writeBundles } from "./index.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const workspacePackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const selectedProfiles = directoriesWith("profiles", "profile.json");
const skills = directoriesWith("skills", "SKILL.md").map((id) => ({ id }));
const checks = Object.fromEntries(selectedProfiles.flatMap((id) => {
  const path = join(repository, "profiles", id, "profile.json");
  const profile = profileDefinitionSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return profile.checks.map(({ id }) => [id, { kind: "mechanical" as const }]);
}));
const artifacts = assembleBundles(repository, {
  version: workspacePackage.version,
  sourceRevision: process.env.AXIOM_BUNDLE_SOURCE_REVISION ?? sourceRevision(),
  policyVersion: "1",
  selectedProfiles,
  skills,
  checks,
  adapters: fixtureAdapters,
});
for (const { directory, manifest } of writeBundles(join(repository, "packages/bundles/dist/fixtures"), artifacts)) {
  console.log(`${manifest.host} fixture: ${directory}`);
}

function directoriesWith(root: string, entrypoint: string): string[] {
  return readdirSync(join(repository, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(repository, root, entry.name, entrypoint)))
    .map((entry) => entry.name)
    .sort();
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
