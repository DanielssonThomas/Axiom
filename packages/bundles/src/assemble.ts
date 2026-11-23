import { realpathSync } from "node:fs";
import { capabilityIdSchema, capabilitySchema, profileDefinitionSchema, profileIdSchema } from "@axiom/contracts";
import type { Capability } from "@axiom/contracts";
import { resolvePolicy } from "@axiom/policy";
import { compare, fileHashes, orderedFiles, readRuntimeFile, runtimePath, sha256 } from "./content.js";
import type { BundleAdapter, BundleArtifact, BundleFile, BundleInput, BundleManifest } from "./model.js";

function loadPolicy(root: string, input: BundleInput) {
  const core = readRuntimeFile(root, "core/AXIOMS.md");
  const profileFiles = new Map<string, BundleFile>();
  const pending = [...input.selectedProfiles];
  for (const id of pending) {
    if (profileFiles.has(id)) continue;
    profileIdSchema.parse(id);
    const file = readRuntimeFile(root, `profiles/${id}/profile.json`);
    const definition = profileDefinitionSchema.parse(JSON.parse(file.text));
    if (definition.id !== id) throw new Error(`Profile ${id} declares a different ID: ${definition.id}.`);
    profileFiles.set(id, file);
    pending.push(...definition.extends);
  }
  const profiles = [...profileFiles.values()];
  const resolution = resolvePolicy({
    core: { ...core, version: input.policyVersion },
    profiles,
    checks: input.checks,
  }, input.selectedProfiles);
  if (!resolution.policy || resolution.diagnostics.length > 0) {
    const issues = resolution.diagnostics.map((issue) => `${issue.path}:${issue.field}: ${issue.message}`);
    throw new Error(`Bundle policy could not be resolved: ${issues.join(" ")}`);
  }
  return {
    identity: resolution.policy.identity,
    files: orderedFiles([
      core,
      ...profiles,
      ...resolution.policy.profiles.map(({ definition }) =>
        readRuntimeFile(root, `profiles/${definition.id}/PROFILE.md`)),
    ]),
  };
}

function loadSkills(root: string, input: BundleInput) {
  const seen = new Set<string>();
  return [...input.skills].sort((a, b) => compare(a.id, b.id)).map(({ id, references = [] }) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64 || seen.has(id)) {
      throw new Error(`Invalid or duplicate skill reference: ${id}.`);
    }
    seen.add(id);
    const directory = `skills/${id}/`;
    const files = orderedFiles([
      readRuntimeFile(root, directory + "SKILL.md"),
      ...references.map((path) => {
        runtimePath(path);
        if (!/^(references|assets|scripts)\//.test(path)) throw new Error(`Invalid skill runtime reference: ${path}.`);
        return readRuntimeFile(root, directory + path);
      }),
    ]);
    return { id, files, digest: sha256(JSON.stringify(fileHashes(files))) };
  });
}

function missingRequirements(adapter: BundleAdapter): Extract<Capability, { available: false }>[] {
  const reported = new Map<string, Capability>();
  for (const value of adapter.capabilities) {
    const capability = capabilitySchema.parse(value);
    if (reported.has(capability.id)) throw new Error(`Duplicate capability ${capability.id} for ${adapter.host}.`);
    reported.set(capability.id, capability);
  }
  return [...new Set(adapter.requiredCapabilities)].sort(compare).flatMap((value) => {
    const id = capabilityIdSchema.parse(value);
    const capability = reported.get(id) ?? { id, available: false, reason: "Adapter did not report this capability." } as const;
    return capability.available ? [] : [capability];
  });
}

/** Assemble runtime payloads from canonical repository files and explicit adapter layouts. */
export function assembleBundles(repository: string, input: BundleInput): BundleArtifact[] {
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(input.version)) throw new Error("Expected a versioned bundle.");
  if (!input.sourceRevision.trim()) throw new Error("Expected a source revision or archive identifier.");
  const root = realpathSync(repository);
  const policy = loadPolicy(root, input);
  const skills = loadSkills(root, input);
  const license = readRuntimeFile(root, "LICENSE");
  const adapterHosts = new Set<string>();
  return [...input.adapters].sort((a, b) => compare(a.host, b.host)).map((adapter) => {
    if (!["claude", "codex", "hermes"].includes(adapter.host) || adapterHosts.has(adapter.host)) {
      throw new Error(`Invalid or duplicate bundle host: ${adapter.host}.`);
    }
    adapterHosts.add(adapter.host);
    const runtimeRoot = adapter.runtimeRoot ? runtimePath(adapter.runtimeRoot) + "/" : "";
    const files = orderedFiles([
      ...[license, ...policy.files, ...skills.flatMap((skill) => skill.files)].map((file) =>
        ({ ...file, path: runtimeRoot + file.path })),
      ...adapter.nativeFiles({ version: input.version, policy: policy.identity }),
    ]);
    if (files.some(({ path }) => path.toLowerCase() === "axiom-bundle.json")) {
      throw new Error("Adapter attempted to replace the bundle manifest.");
    }
    const inventory: Omit<BundleManifest, "digest"> = {
      schemaVersion: 1,
      host: adapter.host,
      version: input.version,
      sourceRevision: input.sourceRevision,
      fixture: adapter.fixture,
      runtimeRoot,
      policy: policy.identity,
      policyContentDigest: sha256(JSON.stringify(fileHashes(policy.files))),
      skills: skills.map(({ id, digest }) => ({ id, digest })),
      missingRequirements: missingRequirements(adapter),
      files: fileHashes(files),
    };
    return { manifest: { ...inventory, digest: sha256(JSON.stringify(inventory)) }, files };
  });
}
