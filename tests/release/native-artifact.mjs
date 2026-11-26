import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexDigest } from "../../packages/cli/dist/native-install.js";
import { supportedVersion as codexVersion } from "../../adapters/codex/dist/index.js";
import { hermesVersion, readBundle, verifyBundle } from "../../adapters/hermes/dist/bundle.js";

export const loadJson = (file) => JSON.parse(readFileSync(file, "utf8"));
export const manifestAt = (distribution) => loadJson(join(distribution, "axiom-distribution.json"));

export async function verifyCodexArtifact(directory, manifest) {
  const codex = manifest.hosts.codex;
  assert.equal(codex.directory, "codex");
  assert.equal(codex.hostVersion, codexVersion);
  const marketplace = join(directory, "codex");
  assert.equal(await codexDigest(marketplace), codex.digest, "Codex file digest differs.");
  const plugin = join(marketplace, "plugins", "axiom");
  assert.deepEqual(loadJson(join(plugin, "axiom-policy.json")).policy, manifest.policy);
  assert.equal(loadJson(join(plugin, ".codex-plugin", "plugin.json")).version, manifest.version);
}

export function verifyHermesArtifact(directory, manifest) {
  const hermes = manifest.hosts.hermes;
  assert.equal(hermes.directory, "hermes");
  assert.equal(hermes.hostVersion, hermesVersion);
  assert.match(hermes.commit, /^[a-f0-9]{40}$/);
  const git = (args) => execFileSync("git", ["--no-replace-objects", "-C", join(directory, "hermes"), ...args], {
    timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(git(["rev-parse", "HEAD"]).toString().trim(), hermes.commit);
  const entries = git(["ls-tree", "-rz", hermes.commit]).toString().split("\0").filter(Boolean);
  const inventory = entries.map((entry) => {
    const match = /^100(?:644|755) blob [a-f0-9]{40}\t([a-zA-Z0-9_.+/-]+)$/.exec(entry);
    assert.ok(match && match[1].split("/").every((part) => part && part !== "." && part !== ".."),
      "Hermes Git artifact contains an unsupported entry.");
    return match[1];
  });
  const path = mkdtempSync(join(tmpdir(), "axiom-v1-artifact-"));
  try {
    execFileSync("tar", ["-xf", "-", "-C", path], { input: git(["archive", hermes.commit]), timeout: 10_000 });
    const bundle = readBundle(path);
    assert.deepEqual(inventory.sort(), ["axiom-bundle.json", ...bundle.files.map(({ path }) => path)].sort());
    verifyBundle(path, bundle);
    assert.equal(bundle.digest, hermes.digest);
    assert.equal(bundle.version, manifest.version);
    assert.equal(bundle.sourceRevision, manifest.sourceRevision);
    assert.deepEqual(bundle.policy, manifest.policy);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}