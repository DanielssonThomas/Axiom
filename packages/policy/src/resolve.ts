import { createHash } from "node:crypto";
import { policyIdentitySchema } from "@axiom/contracts";
import type { PolicyDefinition, ProfileId } from "@axiom/contracts";
import { readCorePolicy, readProfiles, validatePrincipleIds, validateSkillsAndEvaluations } from "./catalog.js";
import { compareText } from "./model.js";
import type {
  EffectiveRequirement,
  InstructionConflict,
  LocatedProfile,
  PolicyCatalog,
  PolicyDiagnostic,
  PolicyResolution,
} from "./model.js";

function orderProfiles(
  profiles: Map<string, LocatedProfile>,
  report: (diagnostic: PolicyDiagnostic) => void,
): LocatedProfile[] {
  const ordered: LocatedProfile[] = [];
  const finished = new Set<string>();
  const visiting = new Set<string>();

  function visit(profile: LocatedProfile) {
    const { id, extends: parents } = profile.definition;
    if (finished.has(id)) return;
    visiting.add(id);
    for (const [index, parentId] of parents.entries()) {
      if (visiting.has(parentId)) {
        const chain = [...visiting, parentId].join(" -> ");
        report({ code: "profile_cycle", path: profile.path, field: `extends.${index}`, message: `Profile inheritance cycle: ${chain}.` });
        continue;
      }
      const parent = profiles.get(parentId);
      if (parent) visit(parent);
    }
    visiting.delete(id);
    finished.add(id);
    ordered.push(profile);
  }

  for (const id of [...profiles.keys()].sort(compareText)) visit(profiles.get(id)!);
  return ordered;
}

function sortedIds(values: readonly string[]) {
  return [...new Set(values)].sort(compareText);
}

function identity(core: PolicyCatalog["core"], definition: PolicyDefinition, profiles: LocatedProfile[], requirements: EffectiveRequirement[]) {
  const normalizedProfiles = profiles.map(({ definition: profile }) => ({
    ...profile,
    extends: sortedIds(profile.extends),
    principleIds: sortedIds(profile.principleIds),
    checks: profile.checks.map((check) => ({ ...check, principleIds: sortedIds(check.principleIds) }))
      .sort((a, b) => compareText(a.id, b.id)),
  }));
  const content = {
    core: core.text.replaceAll("\r\n", "\n"),
    version: definition.version,
    profiles: normalizedProfiles,
    requirements: requirements.map(({ origins: _origins, ...requirement }) => requirement),
  };
  const digest = "sha256:" + createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return policyIdentitySchema.parse({
    version: definition.version,
    digest,
    profiles: normalizedProfiles.map(({ id, version }) => ({ id, version })),
  });
}

/** Resolve supplied canonical documents without reading or modifying host instructions. */
export function resolvePolicy(
  catalog: PolicyCatalog,
  selectedProfiles: readonly ProfileId[],
  instructionConflicts: readonly InstructionConflict[] = [],
): PolicyResolution {
  const diagnostics: PolicyDiagnostic[] = [];
  const report = (code: PolicyDiagnostic["code"], path: string, field: string, message: string) =>
    diagnostics.push({ code, path, field, message });
  const result = (policy?: PolicyResolution["policy"]): PolicyResolution => {
    diagnostics.sort((a, b) => compareText(a.path, b.path) || compareText(a.field, b.field)
      || compareText(a.code, b.code) || compareText(a.message, b.message));
    return policy ? { policy, diagnostics } : { diagnostics };
  };
  const definition = readCorePolicy(catalog.core, report);
  if (!definition) return result();

  const principleIds = new Set(definition.principles.map(({ id }) => id));
  const profiles = readProfiles(catalog, principleIds, report);
  validateSkillsAndEvaluations(catalog, profiles, principleIds, report);
  const ordered = orderProfiles(profiles, (diagnostic) => diagnostics.push(diagnostic));

  for (const [index, id] of selectedProfiles.entries()) {
    if (!profiles.has(id)) report("missing_reference", "selection", `profiles.${index}`, `Unknown selected profile ${id}.`);
  }

  const requirements = new Map<string, EffectiveRequirement>();
  for (const [id, registration] of Object.entries(catalog.checks)) {
    if (!registration.corePrincipleIds?.length) continue;
    validatePrincipleIds(registration.corePrincipleIds, principleIds, catalog.core.path, `checks.${id}.principleIds`, report);
    requirements.set(id, {
      id, kind: registration.kind, required: true, principleIds: sortedIds(registration.corePrincipleIds),
      origins: [{ kind: "core", path: catalog.core.path }],
    });
  }
  if (diagnostics.length > 0) return result();

  const activeIds = new Set(selectedProfiles);
  for (const { definition: profile } of [...ordered].reverse()) {
    if (activeIds.has(profile.id)) for (const parent of profile.extends) activeIds.add(parent);
  }
  const active = ordered.filter(({ definition: profile }) => activeIds.has(profile.id));

  for (const { path, definition: profile } of active) {
    for (const [index, check] of profile.checks.entries()) {
      const principleIds = sortedIds(check.principleIds);
      const origin = { kind: "profile" as const, id: profile.id, path };
      const field = `checks.${index}`;
      const registration = catalog.checks[check.id]!;
      const existing = requirements.get(check.id);
      if (!existing) {
        requirements.set(check.id, { ...check, principleIds, kind: registration.kind, origins: [origin] });
        continue;
      }
      const coreIds = registration.corePrincipleIds ?? [];
      if (coreIds.length > 0 && (!check.required || coreIds.some((id) => !principleIds.includes(id)))) {
        report("core_weakening", path, field, `Profile ${profile.id} cannot weaken core check ${check.id}.`);
        continue;
      }
      const earlierProfile = existing.origins.find((entry) => entry.kind === "profile");
      if (earlierProfile && (existing.required !== check.required
        || existing.principleIds.length !== principleIds.length
        || existing.principleIds.some((id, position) => id !== principleIds[position]))) {
        report("incompatible_requirement", path, field, `Check ${check.id} conflicts with ${earlierProfile.path}.`);
        continue;
      }
      existing.principleIds = principleIds;
      existing.origins.push(origin);
    }
  }
  if (diagnostics.length > 0) return result();

  for (const conflict of instructionConflicts) {
    report("instruction_conflict", conflict.path, conflict.authority, conflict.reason);
  }
  const effectiveRequirements = [...requirements.values()].sort((a, b) => compareText(a.id, b.id));
  for (const requirement of effectiveRequirements) requirement.origins.sort((a, b) => compareText(a.path, b.path));
  active.sort((a, b) => compareText(a.definition.id, b.definition.id));

  return result({
    identity: identity(catalog.core, definition, active, effectiveRequirements),
    principles: definition.principles,
    profiles: active,
    requirements: effectiveRequirements,
  });
}
