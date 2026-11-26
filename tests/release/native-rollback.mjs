import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { transformProfileInstructions } from "../../adapters/codex/dist/bundle.js";
import { readBundle, verifyBundle } from "../../adapters/hermes/dist/bundle.js";
import { codexDigest, runCodexLifecycle } from "../../packages/cli/dist/native-install.js";
import { manifestAt, verifyCodexArtifact, verifyHermesArtifact } from "./native-artifact.mjs";

const [previous, next, codex, hermes, ...rest] = process.argv.slice(2);
assert.ok(previous && next && codex && hermes && rest.length === 0,
  "Usage: node tests/release/native-rollback.mjs PREVIOUS_DIST RELEASE_DIST CODEX_BINARY HERMES_BINARY");
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
const previousDist = resolve(previous);
const nextDist = resolve(next);
const original = manifestAt(previousDist);
const candidate = manifestAt(nextDist);
for (const [path, manifest] of [[previousDist, original], [nextDist, candidate]]) {
  await verifyCodexArtifact(path, manifest);
  verifyHermesArtifact(path, manifest);
}

const digest = (value) => "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
const root = mkdtempSync(join(tmpdir(), "axiom-v1-rollback-"));
const codexHome = join(root, "codex");
const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: codexHome, HERMES_HOME: join(root, "hermes"),
  HERMES_DISABLE_AUTO_UPDATE: "1", HERMES_DISABLE_LAZY_INSTALLS: "1", GIT_CONFIG_GLOBAL: "", GIT_CONFIG_NOSYSTEM: "1",
  TERM: "dumb" };
const run = (program, args) => execFileSync(program, args, { cwd: root, env, encoding: "utf8", timeout: 45_000 });
const identities = (value, overrides) => ({
  sourceRevision: value.sourceRevision, version: value.version, outcome: { status: "passed" }, ...overrides,
});
try {
  mkdirSync(codexHome);
  const agents = join(codexHome, "AGENTS.md");
  const config = join(codexHome, "config.toml");
  const instructions = "Preserve this unrelated operator instruction.\n";
  const codexSetting = 'model = "fixture-model"';
  writeFileSync(agents, instructions);
  writeFileSync(config, codexSetting + "\n");
  const codexVersion = original.hosts.codex.hostVersion;
  assert.ok(run(codex, ["--version"]).includes(codexVersion));
  const installCodex = async (distribution, manifest, action) => {
    const result = await runCodexLifecycle({ action, distribution, program: codex, userHome: root, home: codexHome, workspace: root });
    assert.equal(result.outcome.status, "passed", result.outcome.reason);
    const inventory = JSON.parse(run(codex, ["plugin", "marketplace", "list", "--json"]));
    const market = inventory.marketplaces.find(({ name }) => name === "axiom-local");
    const bundleHash = await codexDigest(market.root);
    assert.equal(bundleHash, manifest.hosts.codex.digest);
    const prompt = run(codex, ["debug", "prompt-input"]);
    assert.ok(prompt.includes(manifest.policy.digest) && prompt.includes("axiom:verify"));
    const preservedInstructions = transformProfileInstructions(readFileSync(agents, "utf8"));
    assert.equal(preservedInstructions, instructions);
    const preservedSetting = readFileSync(config, "utf8").split(/\r?\n/).find((line) => line.startsWith("model = "));
    assert.equal(preservedSetting, codexSetting);
    return identities(manifest, { digest: bundleHash, policy: manifest.policy,
      settingsDigest: digest([preservedInstructions, preservedSetting]) });
  };
  const codexBefore = await installCodex(previousDist, original, "install");
  const codexUpdate = await installCodex(nextDist, candidate, "update");
  const codexRestore = await installCodex(previousDist, original, "update");

  const hermesVersion = original.hosts.hermes.hostVersion;
  assert.ok(run(hermes, ["--version"]).includes(hermesVersion));
  run(hermes, ["profile", "create", "qualification", "--no-alias", "--no-credentials"]);
  const profile = join(env.HERMES_HOME, "profiles", "qualification");
  const soul = join(profile, "SOUL.md");
  const hermesConfig = join(profile, "config.yaml");
  const hermesSettings = { model: { default: "fixture-model" } };
  writeFileSync(soul, instructions);
  writeFileSync(hermesConfig, JSON.stringify(hermesSettings));
  const plugins = (...args) => run(hermes, ["--profile", "qualification", "plugins", ...args]);
  const installHermes = (distribution, manifest, update) => {
    const bundle = manifest.hosts.hermes;
    const origin = pathToFileURL(join(distribution, "hermes")).href;
    plugins("install", origin, "--ref", bundle.commit, ...(update ? ["--force"] : []), "--enable");
    const inventory = JSON.parse(plugins("list", "--user", "--json"));
    assert.ok(inventory.some(({ name, status, version }) => name === "axiom" && status === "enabled" && version === manifest.version));
    const path = join(profile, "plugins", "axiom");
    const observed = readBundle(path);
    verifyBundle(path, observed);
    assert.equal(observed.digest, bundle.digest);
    const preservedInstructions = readFileSync(soul, "utf8");
    assert.equal(preservedInstructions, instructions);
    const model = parse(readFileSync(hermesConfig, "utf8")).model;
    assert.deepEqual(model, hermesSettings.model);
    return identities(manifest, { digest: observed.digest, commit: bundle.commit, policy: observed.policy,
      settingsDigest: digest([preservedInstructions, model]) });
  };
  const hermesBefore = installHermes(previousDist, original, false);
  const hermesUpdate = installHermes(nextDist, candidate, true);
  const hermesRestore = installHermes(previousDist, original, true);
  console.log(JSON.stringify({
    schemaVersion: 1, sourceRevision: candidate.sourceRevision, os: process.platform, architecture: "x86_64",
    previousSourceRevision: original.sourceRevision, previousVersion: original.version,
    hosts: [
      { agent: "codex", version: codexVersion, before: codexBefore, updated: codexUpdate, restored: codexRestore },
      { agent: "hermes", version: hermesVersion, before: hermesBefore, updated: hermesUpdate, restored: hermesRestore },
    ],
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}