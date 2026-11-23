import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { profileDefinitionSchema } from "@axiom/contracts";
import type { PolicyCatalog } from "@axiom/policy";
import { readRuntimeFile } from "./content.js";
import type { SkillSelection } from "./model.js";

export function loadBundleWorkspace(repository: string): { catalog: PolicyCatalog; skills: SkillSelection[] } {
  const root = realpathSync(repository);
  const directoriesWith = (path: string, entrypoint: string) => readdirSync(join(root, path), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, path, entry.name, entrypoint)))
    .map((entry) => entry.name)
    .sort();
  const profiles = directoriesWith("profiles", "profile.json").map((id) => readRuntimeFile(root, `profiles/${id}/profile.json`));
  const checks = Object.fromEntries(profiles.flatMap(({ text }) => profileDefinitionSchema.parse(JSON.parse(text)).checks
    .map(({ id }) => [id, { kind: "mechanical" as const }])));
  const core = { ...readRuntimeFile(root, "core/AXIOMS.md"), version: "1" };
  const skills = directoriesWith("skills", "SKILL.md").map((id) => ({ id }));
  return { catalog: { core, profiles, checks }, skills };
}
