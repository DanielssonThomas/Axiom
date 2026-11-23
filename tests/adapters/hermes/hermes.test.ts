import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { profileDefinitionSchema } from "@axiom/contracts";
import { afterEach, expect, test } from "vitest";
import { assembleBundles, writeBundles } from "../../../packages/bundles/src/index.js";
import { changeHermesPlugin, checkHermesEvent, hermesBundleAdapter, inspectHermesActivation } from "../../../adapters/hermes/src/index.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const workspaces: string[] = [];

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "axiom-hermes-fixture-"));
  workspaces.push(directory);
  return directory;
}

afterEach(() => {
  for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

function write(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

const configuration = "# user settings\nmodel: local:test\nplugins:\n  enabled:\n    - unrelated # retained\n";
function profiles() {
  const home = temporary();
  for (const name of ["alpha", "beta"]) {
    const selected = join(home, "profiles", name);
    write(join(selected, "config.yaml"), configuration);
    write(join(selected, "SOUL.md"), `Personality for ${name}.\n`);
    write(join(selected, "AGENTS.md"), `Identity for ${name}.\n`);
  }
  return { home, profile: "alpha" };
}

function bundle(version = "0.1.0", selectedProfiles: string[] = []) {
  const checks = selectedProfiles.length ? Object.fromEntries(["angular-nx", "ui-atomic"].flatMap((id) =>
    profileDefinitionSchema.parse(JSON.parse(readFileSync(join(repository, "profiles", id, "profile.json"), "utf8")))
      .checks.map((check) => [check.id, { kind: "mechanical" as const }]),
  )) : {};
  return writeBundles(temporary(), assembleBundles(repository, {
    version, sourceRevision: "fixture", policyVersion: "1",
    selectedProfiles, checks, skills: [{ id: "context" }, { id: "verify" }],
    adapters: [hermesBundleAdapter],
  }))[0]!;
}

test("updates only the explicitly selected profile and leaves identity and personality intact", () => {
  const target = profiles();
  const prior = bundle();
  const next = bundle("0.2.0");
  const install = changeHermesPlugin(target, { kind: "install", bundle: prior.directory });
  expect(install.outcome.status).toBe("passed");
  expect(changeHermesPlugin(target, { kind: "install", bundle: prior.directory })).toMatchObject({
    outcome: { status: "passed" }, changed: false,
  });
  expect(changeHermesPlugin(target, { kind: "update", bundle: next.directory })).toMatchObject({
    outcome: { status: "passed" }, changed: true,
  });
  expect(changeHermesPlugin(target, { kind: "update", bundle: next.directory })).toMatchObject({
    outcome: { status: "passed" }, changed: false,
  });

  const alpha = join(target.home, "profiles", "alpha");
  const beta = join(target.home, "profiles", "beta");
  expect(readFileSync(join(beta, "config.yaml"), "utf8")).toBe(configuration);
  for (const name of ["alpha", "beta"]) {
    const path = join(target.home, "profiles", name);
    expect(readFileSync(join(path, "SOUL.md"), "utf8")).toBe(`Personality for ${name}.\n`);
    expect(readFileSync(join(path, "AGENTS.md"), "utf8")).toBe(`Identity for ${name}.\n`);
  }
  expect(readFileSync(join(alpha, "config.yaml"), "utf8")).toContain("unrelated # retained");
  expect(JSON.parse(readFileSync(join(alpha, "plugins/axiom/axiom-bundle.json"), "utf8"))).toMatchObject({
    version: "0.2.0", policy: next.manifest.policy,
  });
  expect(inspectHermesActivation({ ...target, profile: "beta" }).installed.status).toBe("not_run");
});

test("discovers only native observations and binds loading to the selected session and policy", () => {
  const target = profiles();
  const artifact = bundle();
  changeHermesPlugin(target, { kind: "install", bundle: artifact.directory });
  const before = inspectHermesActivation(target, "session-one");
  expect(before).toMatchObject({
    installed: { status: "passed" }, discoverable: { status: "not_run" }, loaded: { status: "not_run" },
    policy: artifact.manifest.policy,
  });
  const folder = join(target.home, "profiles/alpha/.axiom-hermes");
  const instance = "452872cd-ee70-4f43-a602-f3ab2d2e26fb";
  write(join(target.home, "profiles/alpha/plugins/axiom/.axiom-install-instance"), JSON.stringify(instance));
  const text = `Axiom policy digest ${artifact.manifest.policy.digest}`;
  const sections = [{ id: "axiom.policy-000", digest: "sha256:" + createHash("sha256").update(text).digest("hex") }];
  write(join(folder, "registered.json"), JSON.stringify({
    stage: "registered", digest: artifact.manifest.digest, instance,
    sections,
  }));
  expect(inspectHermesActivation(target, "session-one")).toMatchObject({
    discoverable: { status: "passed" }, loaded: { status: "not_run" },
  });
  const observation = { stage: "loaded", digest: artifact.manifest.digest, instance, mechanism: "llm_request", sections };
  write(join(folder, "loaded-session-one.json"), JSON.stringify({ ...observation, session: "session-one" }));
  write(join(folder, "loaded-partial.json"), JSON.stringify({ ...observation, session: "partial", sections: [] }));
  expect(inspectHermesActivation(target, "session-one").loaded.status).toBe("passed");
  expect(inspectHermesActivation(target, "partial").loaded.status).toBe("blocked");
  expect(inspectHermesActivation(target, "another-session").loaded.status).toBe("not_run");
  expect(changeHermesPlugin(target, { kind: "install", bundle: artifact.directory }).changed).toBe(false);
  expect(inspectHermesActivation(target, "session-one").loaded.status).toBe("passed");

  expect(changeHermesPlugin(target, { kind: "disable" }).outcome.status).toBe("passed");
  expect(changeHermesPlugin(target, { kind: "disable" }).changed).toBe(false);
  expect(inspectHermesActivation(target, "session-one").loaded.status).toBe("blocked");
  expect(changeHermesPlugin(target, { kind: "update", bundle: bundle("0.2.0").directory }).outcome.status).toBe("passed");
  expect(inspectHermesActivation(target, "session-one").loaded.status).toBe("blocked");
  expect(changeHermesPlugin(target, { kind: "uninstall" }).outcome.status).toBe("passed");
  expect(changeHermesPlugin(target, { kind: "uninstall" }).changed).toBe(false);
  expect(readFileSync(join(target.home, "profiles/alpha/config.yaml"), "utf8")).toContain("unrelated # retained");
  expect(changeHermesPlugin(target, { kind: "install", bundle: artifact.directory }).outcome.status).toBe("passed");
  expect(inspectHermesActivation(target, "session-one")).toMatchObject({
    installed: { status: "passed" }, discoverable: { status: "not_run" }, loaded: { status: "not_run" },
  });
});

test("keeps a colliding unowned plugin and profile settings untouched", () => {
  const target = profiles();
  const path = join(target.home, "profiles/alpha/plugins/axiom/plugin.yaml");
  write(path, "name: other-axiom\n");
  const artifact = bundle();
  expect(changeHermesPlugin(target, { kind: "install", bundle: artifact.directory }).outcome.status).toBe("blocked");
  expect(changeHermesPlugin(target, { kind: "uninstall" }).outcome.status).toBe("blocked");
  expect(readFileSync(path, "utf8")).toBe("name: other-axiom\n");
  expect(readFileSync(join(target.home, "profiles/alpha/config.yaml"), "utf8")).toBe(configuration);
});

test("requires the live request to carry the selected and inherited profile bytes", () => {
  const target = profiles();
  const artifact = bundle("0.1.0", ["angular-nx"]);
  expect(changeHermesPlugin(target, { kind: "install", bundle: artifact.directory }).outcome.status).toBe("passed");
  const folder = join(target.home, "profiles/alpha/.axiom-hermes");
  const instance = "452872cd-ee70-4f43-a602-f3ab2d2e26fb";
  write(join(target.home, "profiles/alpha/plugins/axiom/.axiom-install-instance"), JSON.stringify(instance));
  const sections = [{ id: "axiom.policy-000", digest: "sha256:" + "a".repeat(64) }];
  const selected = ["angular-nx", "ui-atomic"].map((id) => ({
    id, digest: artifact.manifest.files.find(({ path }) => path === `profiles/${id}/PROFILE.md`)!.digest,
  }));
  const identity = { digest: artifact.manifest.digest, instance, sections };
  write(join(folder, "registered.json"), JSON.stringify({ stage: "registered", ...identity }));
  function observe(session: string, profiles: { id: string; digest: string }[]) {
    write(join(folder, `loaded-${session}.json`), JSON.stringify({
      stage: "loaded", mechanism: "llm_request", session, profiles, ...identity,
    }));
    return inspectHermesActivation(target, session);
  }

  expect(observe("unread", [])).toMatchObject({
    coreLoaded: { status: "passed" },
    loaded: { status: "blocked" },
    profileLoads: selected.map(({ id }) => ({ id, outcome: { status: "not_run" } })),
  });
  const incomplete = observe("stale", [{ id: "angular-nx", digest: "sha256:" + "b".repeat(64) }]);
  expect(incomplete).toMatchObject({
    coreLoaded: { status: "passed" }, loaded: { status: "blocked" },
    profileLoads: [
      { id: "angular-nx", outcome: { status: "blocked" } },
      { id: "ui-atomic", outcome: { status: "not_run" } },
    ],
  });
  expect(observe("retrieved", selected)).toMatchObject({
    coreLoaded: { status: "passed" }, loaded: { status: "passed" },
    profileLoads: selected.map(({ id }) => ({ id, outcome: { status: "passed" } })),
  });
  expect(observe("retrieved", [selected[0]!]).loaded.status).toBe("blocked");
});

test("installs into a newly created named profile before its first configuration write", () => {
  const target = profiles();
  const direct = join(target.home, "profiles/alpha/config.yaml");
  rmSync(direct);
  expect(changeHermesPlugin(target, { kind: "install", bundle: bundle().directory }).outcome.status).toBe("passed");
  expect(readFileSync(direct, "utf8")).toContain("axiom");
  expect(readFileSync(join(target.home, "profiles/beta/config.yaml"), "utf8")).toBe(configuration);
});

test("installed check runtime is self-contained and blocks a session without loading evidence", () => {
  const target = profiles();
  const artifact = bundle();
  const archive = temporary();
  expect(changeHermesPlugin(target, { kind: "install", bundle: artifact.directory }).outcome.status).toBe("passed");
  const directory = join(target.home, "profiles", "alpha", "plugins", "axiom");
  const nativeCheck = spawnSync(process.execPath, [
    join(directory, "checker.mjs"), directory, archive, "pre-tool", "unobserved-session",
  ], { encoding: "utf8", cwd: archive, timeout: 5_000 });
  expect(nativeCheck.status, nativeCheck.stderr).toBe(0);
  expect(JSON.parse(nativeCheck.stdout)).toEqual({
    status: "blocked", reason: "Required Axiom core loading is absent in the current Hermes session.",
  });
});

test("records a passing and intentionally failing native check and blocks unavailable worker or transition coverage", async () => {
  const artifact = bundle();
  const archive = temporary();
  const first = await checkHermesEvent(artifact.directory, archive, "pre-tool");
  expect(first.outcome.status).toBe("passed");
  expect(first.evidence?.policy).toEqual(artifact.manifest.policy);
  write(join(artifact.directory, "core/AXIOMS.md"), "Damaged policy.\n");
  const broken = await checkHermesEvent(artifact.directory, archive, "pre-tool");
  expect(broken.outcome.status).toBe("failed");
  expect(JSON.parse(readFileSync(join(archive, "acceptance", broken.evidence!.id + ".json"), "utf8"))).toEqual(broken.evidence);
  for (const event of ["delegation", "resume", "compaction"] as const) {
    const gap = await checkHermesEvent(artifact.directory, archive, event);
    expect(gap.outcome).toMatchObject({ status: "blocked", reason: expect.stringContaining(event) });
  }
});
