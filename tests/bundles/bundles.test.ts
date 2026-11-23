import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestSchema, policyIdentitySchema, profileDefinitionSchema } from "@axiom/contracts";
import { afterEach, expect, test } from "vitest";
import { assembleBundles, writeBundles } from "../../packages/bundles/src/index.js";
import { applyFixtureLifecycle, fixtureAdapters } from "../../packages/bundles/src/fixtures.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const workspaces: string[] = [];

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "axiom-bundles-"));
  workspaces.push(directory);
  return directory;
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function write(root: string, path: string, text: string) {
  const filename = join(root, path);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, text);
}

function fixture() {
  const directory = temporary();
  for (const path of ["core", "profiles/ui-atomic", "skills/context", "LICENSE", "evals"]) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repository, path), target, { recursive: true });
  }
  for (const path of [".env", "skills/context/credentials.json", "skills/context/evals/held-out.json", ".axiom/runs/current.log"]) {
    write(directory, path, "fixture secret or private grader");
  }
  write(directory, "skills/context/references/paths.md", "Find the owning application.\n");
  return directory;
}

function options() {
  const profile = profileDefinitionSchema.parse(JSON.parse(readFileSync(join(repository, "profiles/ui-atomic/profile.json"), "utf8")));
  return {
    version: "0.1.0",
    sourceRevision: "f099386029f08d145a49e8df361361275557ffe2",
    policyVersion: "1",
    selectedProfiles: [profile.id],
    skills: [{ id: "context", references: ["references/paths.md"] }],
    checks: Object.fromEntries(profile.checks.map(({ id }) => [id, { kind: "mechanical" as const }])),
    adapters: fixtureAdapters,
  };
}

function filesAt(directory: string) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1).replaceAll("\\", "/"))
    .sort();
}

test("writes reproducible native layouts and the same canonical policy and skill hashes", () => {
  const source = fixture();
  const build = options();
  const first = writeBundles(temporary(), assembleBundles(source, build));
  const second = writeBundles(temporary(), assembleBundles(source, {
    ...build, adapters: [...build.adapters].reverse(),
  }));
  expect(first).toHaveLength(3);
  expect(first.map(({ manifest }) => manifest.host)).toEqual(["claude", "codex", "hermes"]);
  expect(new Set(first.map(({ manifest }) => manifest.policy.digest)).size).toBe(1);
  expect(new Set(first.map(({ manifest }) => manifest.policyContentDigest)).size).toBe(1);
  expect(new Set(first.map(({ manifest }) => manifest.skills[0]?.digest)).size).toBe(1);
  expect(new Set(first.map(({ manifest }) => manifest.digest)).size).toBe(3);

  const nativeManifest = {
    claude: "plugins/axiom/.claude-plugin/plugin.json",
    codex: "plugins/axiom/.codex-plugin/plugin.json",
    hermes: "plugin.yaml",
  };
  for (const [index, { directory, manifest }] of first.entries()) {
    expect(manifest.version).toBe(build.version);
    expect(manifest.sourceRevision).toBe(build.sourceRevision);
    expect(manifest.fixture).toBe(true);
    expect(policyIdentitySchema.safeParse(manifest.policy).success).toBe(true);
    expect(digestSchema.safeParse(manifest.skills[0]?.digest).success).toBe(true);
    const other = second[index]!;
    expect(other.manifest).toEqual(manifest);
    const filenames = filesAt(directory);
    expect(filenames).toContain(nativeManifest[manifest.host]);
    expect(filenames).toContain(manifest.runtimeRoot + "skills/context/references/paths.md");
    const shipped = filenames.filter((path) => path !== "axiom-bundle.json");
    expect(shipped).toEqual(manifest.files.map(({ path }) => path));
    expect(filesAt(other.directory)).toEqual(filenames);
    for (const path of filenames) {
      expect(readFileSync(join(other.directory, path))).toEqual(readFileSync(join(directory, path)));
    }
  }
});

test("ships only declared runtime files and detects changes in normalized content", () => {
  const source = fixture();
  const first = assembleBundles(source, options())[0]!;
  expect(first.manifest.files.map(({ path }) => path)).toEqual([
    ".claude-plugin/marketplace.json",
    "plugins/axiom/.claude-plugin/plugin.json",
    "plugins/axiom/LICENSE",
    "plugins/axiom/core/AXIOMS.md",
    "plugins/axiom/profiles/ui-atomic/PROFILE.md",
    "plugins/axiom/profiles/ui-atomic/profile.json",
    "plugins/axiom/skills/context/SKILL.md",
    "plugins/axiom/skills/context/references/paths.md",
  ]);
  const path = "skills/context/references/paths.md";
  write(source, path, "Find the owning application.\r\n");
  const normalized = assembleBundles(source, options())[0]!;
  expect(normalized.manifest).toEqual(first.manifest);
  write(source, path, "Find the owning feature.\n");
  const edited = assembleBundles(source, options())[0]!;
  expect(edited.manifest.skills).not.toEqual(first.manifest.skills);
  expect(edited.manifest.policy).toEqual(first.manifest.policy);
  write(source, "profiles/ui-atomic/PROFILE.md", "A new profile instruction.\n");
  expect(assembleBundles(source, options())[0]!.manifest.policyContentDigest).not.toBe(first.manifest.policyContentDigest);
});

test.each(["references/missing.md", "../.env", "evals/held-out.json", "references/credentials.json"])(
  "rejects invalid or private skill references %s",
  (reference) => {
    const source = fixture();
    expect(() => assembleBundles(source, { ...options(), skills: [{ id: "context", references: [reference] }] }))
      .toThrow(/reference|runtime path|credential/i);
  },
);

test("rejects a runtime reference that redirects through a symlink and a missing selected profile", () => {
  const source = fixture();
  const outside = temporary();
  write(outside, "linked.md", "This file is outside the bundle source.");
  symlinkSync(outside, join(source, "skills/context/references/linked"), "junction");
  expect(() => assembleBundles(source, { ...options(), skills: [{ id: "context", references: ["references/linked/linked.md"] }] }))
    .toThrow(/symlink/i);
  expect(() => assembleBundles(source, { ...options(), selectedProfiles: ["missing"] })).toThrow(/profile/i);
});

test("allows an identical rebuild and rejects unexpected files at a versioned artifact path", () => {
  const source = fixture();
  const output = temporary();
  const artifacts = assembleBundles(source, { ...options(), version: "0.1.0-rc.1+fixture" });
  const written = writeBundles(output, artifacts);
  expect(writeBundles(output, artifacts)).toEqual(written);
  const directory = written[0]!.directory;
  write(directory, "unexpected.txt", "Drift");
  expect(() => writeBundles(output, artifacts)).toThrow("Existing artifact differs at unexpected.txt.");
  expect(readFileSync(join(directory, "unexpected.txt"), "utf8")).toBe("Drift");
});

test("enumerates absent adapter requirements and refuses fixture installation with gaps", () => {
  const source = fixture();
  const adapter = { ...fixtureAdapters[0]!, requiredCapabilities: ["resume", "delegation"], capabilities: [
    { id: "resume", available: false, reason: "unsupported" },
  ] } as const;
  const manifest = assembleBundles(source, { ...options(), adapters: [adapter] })[0]!.manifest;
  expect(manifest.missingRequirements).toEqual([
    { id: "delegation", available: false, reason: "Adapter did not report this capability." },
    { id: "resume", available: false, reason: "unsupported" },
  ]);
  const original = { plugins: { unrelated: { enabled: true } } };
  expect(applyFixtureLifecycle(original, manifest, "install")).toMatchObject({
    configuration: original, outcome: { status: "blocked", reason: expect.stringContaining("delegation") },
  });
});

test("rejects an adapter that declares evaluation-only runtime files", () => {
  const source = fixture();
  const adapter = { ...fixtureAdapters[0]!, nativeFiles: () => [{ path: "private/graders/rules.js", text: "grader" }] };
  expect(() => assembleBundles(source, { ...options(), adapters: [adapter] }))
    .toThrow("Invalid runtime path: private/graders/rules.js.");
});

test.each(fixtureAdapters)("preserves unrelated $host fixture configuration through update and uninstall", (adapter) => {
  const source = fixture();
  const build = options();
  const prior = assembleBundles(source, { ...build, adapters: [adapter] })[0]!.manifest;
  const next = assembleBundles(source, { ...build, version: "0.2.0", adapters: [adapter] })[0]!.manifest;
  const original = { persona: { name: "Demo" }, plugins: { unrelated: { enabled: true, setting: "custom" } } };
  const installed = applyFixtureLifecycle(original, prior, "install");
  expect(installed.outcome.status).toBe("passed");
  expect(applyFixtureLifecycle(installed.configuration, prior, "install")).toEqual(installed);
  const disabled = applyFixtureLifecycle(installed.configuration, prior, "disable");
  const updated = applyFixtureLifecycle(disabled.configuration, next, "update");
  expect(updated.outcome.status).toBe("passed");
  expect(updated.configuration).toMatchObject({
    ...original, plugins: { ...original.plugins, axiom: { enabled: false, version: next.version, digest: next.digest } },
  });
  expect(applyFixtureLifecycle(updated.configuration, next, "update")).toEqual(updated);
  expect(applyFixtureLifecycle(updated.configuration, next, "uninstall")).toEqual({ configuration: original, outcome: { status: "passed" } });
  expect(applyFixtureLifecycle(original, next, "uninstall")).toEqual({ configuration: original, outcome: { status: "passed" } });
});

test("leaves an unowned entry with the same plugin name untouched", () => {
  const original = { plugins: { axiom: { enabled: true, version: "custom" } } };
  const manifest = assembleBundles(fixture(), options())[0]!.manifest;
  for (const operation of ["install", "update", "disable", "uninstall"] as const) {
    expect(applyFixtureLifecycle(original, manifest, operation)).toMatchObject({
      configuration: original, outcome: { status: "blocked" },
    });
  }
});
