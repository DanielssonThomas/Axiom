import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const fixtureProfile = "fixture-profile";
export const fixtureProfileHeading = "# Fixture profile";

/** Add a test-only child profile to a disposable copy of the runtime sources. */
export function createProfileWorkspace(source: string, destination: string): string {
  mkdirSync(destination, { recursive: true });
  for (const path of ["LICENSE", "core", "skills", "profiles/ui-atomic"]) {
    cpSync(join(source, path), join(destination, path), { recursive: true });
  }
  const profile = join(destination, "profiles", fixtureProfile);
  mkdirSync(profile);
  writeFileSync(join(profile, "profile.json"), JSON.stringify({
    id: fixtureProfile, version: "1", extends: ["ui-atomic"], principleIds: ["AX-03"], checks: [],
  }));
  writeFileSync(join(profile, "PROFILE.md"), `${fixtureProfileHeading}\n\nThis content exercises native profile inheritance.\n`);
  return destination;
}
