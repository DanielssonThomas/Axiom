import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { digestSchema, policyIdentitySchema } from "@axiom/contracts";
import type { BundleAdapter, BundleManifest } from "@axiom/bundles";
import type { Capability } from "@axiom/contracts";
import { parse } from "yaml";

export const hermesVersion = "0.23.3";

export const hermesCapabilities = [
  { id: "process-execution", available: true },
  { id: "action-trace", available: false, reason: "Hermes stream JSON exposes tool events without the independent structured action evidence required by shared graders." },
  { id: "delegation", available: false, reason: "Hermes worker inheritance has no verified Axiom policy-loading evidence." },
  { id: "resume", available: false, reason: "The adapter cannot attest policy coverage across resumed Hermes sessions." },
  { id: "compaction", available: false, reason: "The adapter cannot attest policy coverage across Hermes compaction." },
] as const satisfies readonly Capability[];

export const hermesBundleAdapter: BundleAdapter = {
  host: "hermes",
  runtimeRoot: "",
  fixture: false,
  requiredCapabilities: ["native-package"],
  capabilities: [{ id: "native-package", available: true }],
  nativeFiles: ({ version }) => [{
    path: "plugin.yaml",
    text: `name: axiom\nversion: ${JSON.stringify(version)}\ndescription: "Canonical Axiom policy and engineering skills"\n`,
  }, {
    path: "__init__.py",
    text: readFileSync(new URL("../runtime/__init__.py", import.meta.url), "utf8"),
  }, {
    path: "checker.mjs",
    text: readFileSync(new URL("../dist/checker.mjs", import.meta.url), "utf8"),
  }],
};

export function digest(text: string | Buffer): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

function assertFilePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path.split("/").some((entry) => !/^[a-z0-9_.+-]+$/i.test(entry) || entry.endsWith("."))) {
    throw new Error("Invalid path in the bundle inventory.");
  }
}

export function readBundle(root: string): BundleManifest {
  const { digest: expected, ...metadata } = JSON.parse(readFileSync(join(root, "axiom-bundle.json"), "utf8"));
  if (metadata.schemaVersion !== 1 || metadata.host !== "hermes" || metadata.fixture !== false
      || metadata.runtimeRoot !== "" || typeof metadata.version !== "string"
      || !Array.isArray(metadata.files) || !Array.isArray(metadata.skills)
      || !Array.isArray(metadata.missingRequirements) || metadata.missingRequirements.length !== 0
      || digest(JSON.stringify(metadata)) !== digestSchema.parse(expected)) {
    throw new Error("Expected an intact supported Hermes bundle manifest.");
  }
  policyIdentitySchema.parse(metadata.policy);
  const inventory = new Set<string>();
  for (const item of metadata.files) {
    assertFilePath(item.path);
    if (inventory.has(item.path)) throw new Error("Duplicate file in bundle inventory.");
    inventory.add(item.path);
    digestSchema.parse(item.digest);
  }
  for (const file of ["plugin.yaml", "__init__.py", "checker.mjs", "core/AXIOMS.md"]) {
    if (!inventory.has(file)) throw new Error(`The Hermes bundle is missing ${file}.`);
  }
  for (const { id } of metadata.skills) {
    if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !inventory.has(`skills/${id}/SKILL.md`)) {
      throw new Error("The Hermes bundle lists an invalid or missing skill.");
    }
  }
  return { ...metadata, digest: expected };
}

export function verifyBundle(root: string, manifest: BundleManifest): void {
  for (const file of manifest.files) {
    const path = join(root, file.path);
    if (realpathSync(path) !== path || digest(readFileSync(path)) !== file.digest) {
      throw new Error(`Hermes bundle content differs at ${file.path}.`);
    }
  }
  const native = parse(readFileSync(join(root, "plugin.yaml"), "utf8"));
  if (native?.name !== "axiom" || native.version !== manifest.version) throw new Error("Hermes plugin metadata does not match the bundle.");
}
