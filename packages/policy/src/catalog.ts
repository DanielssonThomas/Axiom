import {
  evaluationCaseSchema,
  policyDefinitionSchema,
  principleIdSchema,
  profileDefinitionSchema,
} from "@axiom/contracts";
import { parseDocument } from "yaml";
import { compareText } from "./model.js";
import type { LocatedProfile, PolicyCatalog, PolicyDiagnostic, PolicySource } from "./model.js";

type Report = (code: PolicyDiagnostic["code"], path: string, field: string, message: string) => void;
type Issue = { path: readonly PropertyKey[]; message: string };

function readJson(source: PolicySource, report: Report): unknown {
  try {
    return JSON.parse(source.text);
  } catch {
    report("malformed_definition", source.path, "", "Expected valid JSON.");
  }
}

function reportDefinitionIssues(path: string, issues: readonly Issue[], report: Report) {
  for (const issue of issues) {
    report("malformed_definition", path, issue.path.map(String).join("."), issue.message);
  }
}

export function readCorePolicy(core: PolicyCatalog["core"], report: Report) {
  const seen = new Set<string>();
  const principles = [];
  const headings = core.text.split(/\r?\n/).entries();
  for (const [index, line] of headings) {
    if (!/^##[ \t]+AX-/.test(line)) continue;
    const field = `line.${index + 1}`;
    const id = principleIdSchema.safeParse(/^##[ \t]+(\S+)[ \t]+—[ \t]+\S/.exec(line)?.[1]);
    if (!id.success) {
      report("malformed_definition", core.path, field, "Expected a principle heading with an ID and title.");
      continue;
    }
    if (seen.has(id.data)) {
      report("duplicate_id", core.path, field, `Duplicate principle ${id.data}.`);
      continue;
    }
    seen.add(id.data);
    principles.push({ id: id.data, version: core.version, source: core.path });
  }

  const parsed = policyDefinitionSchema.safeParse({ version: core.version, principles });
  if (parsed.success) return parsed.data;
  reportDefinitionIssues(core.path, parsed.error.issues, report);
}

export function readProfiles(catalog: PolicyCatalog, principles: Set<string>, report: Report) {
  const profiles = new Map<string, LocatedProfile>();
  for (const source of [...catalog.profiles].sort((a, b) => compareText(a.path, b.path))) {
    const raw = readJson(source, report);
    if (raw === undefined) continue;
    const parsed = profileDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      reportDefinitionIssues(source.path, parsed.error.issues, report);
      continue;
    }
    const profile = parsed.data;
    if (profiles.has(profile.id)) {
      report("duplicate_id", source.path, "id", `Profile ${profile.id} is already defined at ${profiles.get(profile.id)?.path}.`);
      continue;
    }
    profiles.set(profile.id, { path: source.path, definition: profile });
    validatePrincipleIds(profile.principleIds, principles, source.path, "principleIds", report);

    const seenChecks = new Set<string>();
    for (const [index, check] of profile.checks.entries()) {
      const field = `checks.${index}`;
      if (seenChecks.has(check.id)) report("duplicate_id", source.path, `${field}.id`, `Duplicate check ${check.id}.`);
      seenChecks.add(check.id);
      if (!Object.hasOwn(catalog.checks, check.id)) report("unknown_check", source.path, `${field}.id`, `Unregistered check ${check.id}.`);
      validatePrincipleIds(check.principleIds, principles, source.path, `${field}.principleIds`, report);
    }
  }

  for (const { path, definition } of profiles.values()) {
    for (const [index, parent] of definition.extends.entries()) {
      if (!profiles.has(parent)) report("missing_reference", path, `extends.${index}`, `Unknown parent profile ${parent}.`);
    }
  }

  return profiles;
}

export function validatePrincipleIds(ids: readonly string[], known: Set<string>, path: string, field: string, report: Report) {
  for (const [index, id] of ids.entries()) {
    if (!known.has(id)) report("unknown_principle", path, `${field}.${index}`, `Unknown principle ${id}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMetadataText(value: unknown, limit: number): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= limit;
}

function validateSkill(source: PolicySource, report: Report): string | undefined {
  const directory = /(?:^|\/)skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/.exec(source.path.replaceAll("\\", "/"))?.[1];
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(source.text);
  let metadata: unknown;
  try {
    if (frontmatter?.[1] && frontmatter.index === 0) {
      const document = parseDocument(frontmatter[1]);
      if (document.errors.length === 0 && document.warnings.length === 0) metadata = document.toJS();
    }
  } catch {
    // Invalid YAML aliases are handled as malformed metadata alongside syntax errors.
  }

  if (!isRecord(metadata)) {
    report("invalid_skill_metadata", source.path, "", "Expected a YAML frontmatter mapping at the start of SKILL.md.");
    return;
  }

  if (!directory || directory.length > 64 || metadata.name !== directory) {
    report("invalid_skill_metadata", source.path, "name", "Use the skill directory's lowercase hyphenated name (up to 64 characters).");
  }
  if (!isMetadataText(metadata.description, 1024)) {
    report("invalid_skill_metadata", source.path, "description", "Describe the skill and its applicability in at most 1024 characters.");
  }
  if (Object.hasOwn(metadata, "compatibility") && !isMetadataText(metadata.compatibility, 500)) {
    report("invalid_skill_metadata", source.path, "compatibility", "Expected compatibility text of at most 500 characters.");
  }
  for (const field of ["license", "allowed-tools"]) {
    if (Object.hasOwn(metadata, field) && typeof metadata[field] !== "string") {
      report("invalid_skill_metadata", source.path, field, "Expected text.");
    }
  }
  if (Object.hasOwn(metadata, "metadata")
    && (!isRecord(metadata.metadata) || Object.values(metadata.metadata).some((value) => typeof value !== "string"))) {
    report("invalid_skill_metadata", source.path, "metadata", "Expected a mapping of string values.");
  }
  return directory;
}

function validateEvaluation(source: PolicySource, profiles: Map<string, LocatedProfile>, principles: Set<string>, report: Report) {
  const raw = readJson(source, report);
  if (raw === undefined) return;
  const parsed = evaluationCaseSchema.safeParse(raw);
  if (!parsed.success) {
    reportDefinitionIssues(source.path, parsed.error.issues, report);
    return;
  }
  const { profiles: references, principleIds, skill } = parsed.data;
  const owner = /(?:^|\/)skills\/([^/]+)\/evals\/.+\.json$/.exec(source.path.replaceAll("\\", "/"))?.[1];
  validatePrincipleIds(principleIds, principles, source.path, "principleIds", report);
  for (const [index, ref] of references.entries()) {
    const found = profiles.get(ref.id);
    if (!found) report("missing_reference", source.path, `profiles.${index}.id`, `Unknown profile ${ref.id}.`);
    else if (found.definition.version !== ref.version) {
      report("missing_reference", source.path, `profiles.${index}.version`, `Unknown version ${ref.version} of profile ${ref.id}.`);
    }
  }
  if (owner && skill && skill.id !== owner) {
    report("missing_reference", source.path, "skill.id", `The evaluation belongs to skill ${owner}, not ${skill.id}.`);
  }
  return { owner, skill: skill?.id };
}

export function validateSkillsAndEvaluations(catalog: PolicyCatalog, profiles: Map<string, LocatedProfile>, principles: Set<string>, report: Report) {
  const skills = new Map<string, { path: string; valid: boolean }>();
  for (const source of [...catalog.skills ?? []].sort((a, b) => compareText(a.path, b.path))) {
    let valid = true;
    const id = validateSkill(source, (...diagnostic) => {
      valid = false;
      report(...diagnostic);
    });
    if (id === undefined) continue;
    const previous = skills.get(id);
    if (previous) report("duplicate_id", source.path, "name", `Skill ${id} is already defined at ${previous.path}.`);
    else skills.set(id, { path: source.path, valid });
  }

  const linked = new Set<string>();
  for (const source of catalog.evaluations ?? []) {
    let valid = true;
    const result = validateEvaluation(source, profiles, principles, (...diagnostic) => {
      valid = false;
      report(...diagnostic);
    });
    if (!result) continue;
    const skill = result.owner ?? result.skill;
    if (skill && !skills.has(skill)) {
      report("missing_reference", source.path, "skill.id", `Unknown skill ${skill}.`);
    }
    if (valid && result.owner) linked.add(result.owner);
  }
  for (const [id, { path, valid }] of skills) {
    if (valid && !linked.has(id)) report("missing_evaluation", path, "evals", `Skill ${id} requires a valid colocated evaluation.`);
  }
}
