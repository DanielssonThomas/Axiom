import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyCatalog } from "../../packages/policy/src/index.js";
import { diagnose, formatDiagnosis } from "../../packages/doctor/src/index.js";
import { afterEach, beforeEach, expect, test } from "vitest";

const core = readFileSync(new URL("../../core/AXIOMS.md", import.meta.url), "utf8");
const catalog: PolicyCatalog = {
  core: { path: "core/AXIOMS.md", text: core, version: "1" },
  profiles: [{ path: "profiles/sample/profile.json", text: JSON.stringify({
    id: "sample", version: "1", extends: [], principleIds: ["AX-05"], checks: [],
  }) }],
  checks: {},
};
const text = "# Verify the outcome\n";
const contentDigest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
const host = { agent: "codex", version: "1.2.3", os: "linux", model: "example", surface: "cli" };
const source = { id: "verify", kind: "skill", path: "SKILL.md", selected: true, digest: contentDigest };
const pass = { status: "passed" };
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "axiom-doctor-"));
  writeFileSync(join(root, source.path), text);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function checkedConfig(overrides: Record<string, unknown> = {}) {
  return {
    profiles: [{ id: "sample", version: "1" }],
    sources: [source],
    host,
    supportedHostVersions: ["1.2.3"],
    capabilities: [{ id: "process-execution", available: true }],
    ...overrides,
  };
}

test("reports resolved policy and stages backed by matching host observations without changing files", async () => {
  const report = await diagnose({
    root, catalog, config: checkedConfig(),
    observations: [{
      host, path: source.path, digest: contentDigest, mechanism: "fixture plugin event",
      stages: { discoverable: pass, loaded: pass, enforced: pass },
    }],
  });

  expect(report).toMatchObject({
    policy: {
      identity: { version: "1", profiles: [{ id: "sample", version: "1" }] },
      principles: expect.arrayContaining([{ id: "AX-05", version: "1", source: "core/AXIOMS.md" }]),
    },
    sources: [{ ...source, installed: pass, discoverable: pass, loaded: pass, enforced: pass }],
    diagnostics: [],
    capabilities: [{ id: "process-execution", available: true }],
  });
  expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  expect(readdirSync(root)).toEqual([source.path]);
  expect(readFileSync(join(root, source.path), "utf8")).toBe(text);
  expect(formatDiagnosis(report)).toContain("loaded passed");
});

test("installation and selection cannot establish discovery, loading, or enforcement", async () => {
  const report = await diagnose({ root, catalog, config: checkedConfig() });
  expect(report).toMatchObject({
    sources: [{
      installed: pass,
      discoverable: { status: "not_run", reason: expect.any(String) },
      loaded: { status: "not_run", reason: expect.any(String) },
      enforced: { status: "not_run", reason: expect.any(String) },
    }],
  });
});

test("reports missing source and ignores observations of old content after drift", async () => {
  writeFileSync(join(root, source.path), "# Changed instructions\n");
  const report = await diagnose({
    root, catalog,
    config: checkedConfig({
      sources: [source, { id: "core", kind: "instruction", path: "MISSING.md", selected: false }],
    }),
    observations: [{
      host, path: source.path, digest: contentDigest, mechanism: "older plugin event", stages: { loaded: pass },
    }],
  });

  expect(report).toMatchObject({
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: "missing_source", subject: "MISSING.md", status: "blocked", remediation: expect.any(String) }),
      expect.objectContaining({ code: "content_drift", subject: source.path, status: "failed", remediation: expect.any(String) }),
      expect.objectContaining({ code: "stale_observation", subject: source.path, status: "blocked", remediation: expect.any(String) }),
    ]),
    sources: expect.arrayContaining([
      expect.objectContaining({ path: "MISSING.md", installed: expect.objectContaining({ status: "blocked" }) }),
      expect.objectContaining({ path: source.path, installed: pass, loaded: expect.objectContaining({ status: "blocked" }) }),
    ]),
  });
  expect(readFileSync(join(root, source.path), "utf8")).toContain("Changed instructions");
});

test("detects a shadowed candidate and conflicting selected native sources", async () => {
  writeFileSync(join(root, "legacy.md"), "Older policy");
  const candidate = { id: source.id, kind: source.kind, path: "legacy.md", selected: false };
  const shadowed = await diagnose({ root, catalog, config: checkedConfig({ sources: [source, candidate] }) });
  expect(shadowed).toMatchObject({ diagnostics: [
    { code: "shadowed_source", subject: "legacy.md", status: "blocked", reason: expect.stringContaining("SKILL.md") },
  ] });

  const conflicting = await diagnose({
    root, catalog, config: checkedConfig({ sources: [source, { ...candidate, selected: true }] }),
    instructionConflicts: [{ authority: "user", path: "AGENTS.md", reason: "The selected check conflicts with the request." }],
  });
  expect(conflicting).toMatchObject({ diagnostics: expect.arrayContaining([
    expect.objectContaining({ code: "conflicting_sources", subject: "verify", status: "blocked" }),
    expect.objectContaining({ code: "instruction_conflict", subject: "AGENTS.md", status: "blocked" }),
  ]) });
});

test("reports explicit unsupported capabilities and incompatible declared versions", async () => {
  const report = await diagnose({ root, catalog, config: checkedConfig({
    profiles: [{ id: "sample", version: "2" }],
    supportedHostVersions: ["2.0"],
    capabilities: [{ id: "delegation", available: false, reason: "unsupported" }],
  }) });

  expect(report).toMatchObject({
    capabilities: [{ id: "delegation", available: false, reason: "unsupported" }],
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: "profile_version", subject: "sample", status: "failed", remediation: expect.any(String) }),
      expect.objectContaining({ code: "host_version", subject: "codex", status: "failed", remediation: expect.any(String) }),
      expect.objectContaining({ code: "capability_gap", subject: "delegation", status: "blocked", reason: "unsupported" }),
    ]),
  });
  expect(formatDiagnosis(report)).toContain("unsupported");
});

test("invalid configuration is explicit and does not inspect unvalidated sources", async () => {
  const report = await diagnose({
    root, catalog, config: checkedConfig({ profiles: [{ id: "Sample", version: "" }] }),
  });
  expect(report).toMatchObject({
    diagnostics: [
      { code: "invalid_config", subject: "profiles.0.id", status: "failed", remediation: expect.any(String) },
      { code: "invalid_config", subject: "profiles.0.version", status: "failed", remediation: expect.any(String) },
    ],
    sources: [],
  });
});

test("a matching file alone cannot certify activation for the reported host", async () => {
  const report = await diagnose({
    root, catalog, config: checkedConfig(),
    observations: [{
      host: { ...host, version: "1.0.0" }, path: source.path, digest: contentDigest, mechanism: "older host event",
      stages: { loaded: pass },
    }],
  });
  expect(report.sources[0]?.loaded).toMatchObject({ status: "blocked", reason: expect.stringContaining("host identity") });
  expect(report.diagnostics).toMatchObject([{ code: "stale_observation", status: "blocked" }]);
});
