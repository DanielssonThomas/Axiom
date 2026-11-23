import type { Capability, PolicyIdentity, ProfileId } from "@axiom/contracts";
import type { PolicyCatalog } from "@axiom/policy";

export type BundleHost = "claude" | "codex" | "hermes";

export interface BundleFile {
  path: string;
  text: string;
}

export interface SkillSelection {
  id: string;
  /** Explicit runtime paths relative to the canonical skill, such as references/use.md. */
  references?: readonly string[];
}

export interface BundleAdapter {
  host: BundleHost;
  /** Plugin root relative to the artifact root. An empty string denotes the artifact root. */
  runtimeRoot: string;
  fixture: boolean;
  capabilities: readonly Capability[];
  requiredCapabilities: readonly string[];
  nativeFiles(input: { version: string; policy: PolicyIdentity }): readonly BundleFile[];
}

export interface BundleInput {
  version: string;
  sourceRevision: string;
  policyVersion: string;
  selectedProfiles: readonly ProfileId[];
  skills: readonly SkillSelection[];
  checks: PolicyCatalog["checks"];
  adapters: readonly BundleAdapter[];
}

export interface BundleManifest {
  schemaVersion: 1;
  host: BundleHost;
  version: string;
  sourceRevision: string;
  fixture: boolean;
  runtimeRoot: string;
  policy: PolicyIdentity;
  policyContentDigest: string;
  skills: readonly { id: string; digest: string }[];
  missingRequirements: readonly Extract<Capability, { available: false }>[];
  files: readonly { path: string; digest: string }[];
  digest: string;
}

export interface BundleArtifact {
  manifest: BundleManifest;
  files: readonly BundleFile[];
}

export interface WrittenBundle {
  manifest: BundleManifest;
  directory: string;
}
