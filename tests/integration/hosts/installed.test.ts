import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { EvidenceOutcome, HostIdentity, PolicyIdentity } from "@axiom/contracts";
import { expect, test } from "vitest";
import * as claude from "../../../adapters/claude/src/index.js";
import { nativeJson } from "../../../adapters/claude/src/process.js";
import * as codex from "../../../adapters/codex/src/index.js";
import { runCodex } from "../../../adapters/codex/src/process.js";
import * as hermes from "../../../adapters/hermes/src/index.js";
import { runHermes } from "../../../adapters/hermes/src/process.js";
import { assembleBundles, loadBundleWorkspace, writeBundles } from "../../../packages/bundles/src/index.js";
import { snapshotSource } from "../../../packages/evidence/src/index.js";
import { inspectComposition } from "../../../profiles/ui-atomic/checks.js";
import { assessInstalledHost, transportRequirements } from "./qualification.js";
import { openLoopback, ordinaryPrompt, type NativeHost, type NativeLoopback } from "./loopback.js";

const skills = ["context", "delegate", "design", "diagnose", "knowledge", "verify"] as const;
const projectInstruction = "Retain the disposable team's existing project instruction.";
const userInstruction = "Retain the disposable user's existing profile instruction.";
const passed = { status: "passed" } as const;
const blocked = (reason: string): EvidenceOutcome => ({ status: "blocked", reason });
const rows = [
  { agent: "claude", version: claude.supportedVersion, model: "claude-sonnet-4-6", env: "AXIOM_TEST_CLAUDE_BINARY" },
  { agent: "codex", version: codex.supportedVersion, model: "gpt-5.4", env: "AXIOM_TEST_CODEX_BINARY" },
  { agent: "hermes", version: hermes.hermesVersion, model: "fixture-model", env: "AXIOM_HERMES_CLI" },
] as const;

interface Fixture {
  root: string;
  workspace: string;
  source: string;
  revision: string;
  executable: string;
  host: HostIdentity;
  loopback: NativeLoopback;
  signal: AbortSignal;
}

interface InstalledFixture {
  core: PolicyIdentity;
  updatedPolicy: PolicyIdentity;
  digest: string;
  updatedDigest: string;
  mechanism: string;
  install(): Promise<void>;
  update(): Promise<void>;
  disable(): Promise<void>;
  uninstall(): Promise<void>;
  session(enabled: boolean): Promise<EvidenceOutcome>;
  assertPreserved(): Promise<void>;
  brokenControl(): Promise<EvidenceOutcome>;
}

async function claudeFixture(input: Fixture): Promise<InstalledFixture> {
  const { root, workspace, source, revision, executable, host, loopback, signal } = input;
  const profile = {
    program: executable, workspace, home: join(root, "claude"), userHome: join(root, "user"),
    environment: { ANTHROPIC_BASE_URL: loopback.endpoint, ANTHROPIC_AUTH_TOKEN: "loopback-only" },
  };
  await Promise.all([mkdir(profile.home), mkdir(profile.userHome), mkdir(join(workspace, ".claude"))]);
  const settings = join(profile.home, "settings.json");
  const local = join(workspace, ".claude", "settings.local.json");
  const user = join(profile.home, "CLAUDE.md");
  const project = join(workspace, "CLAUDE.md");
  const setting = { env: { DISPOSABLE_FIXTURE_VALUE: "preserve" } };
  await Promise.all([writeFile(settings, JSON.stringify(setting)), writeFile(local, JSON.stringify(setting)),
    writeFile(user, userInstruction), writeFile(project, projectInstruction)]);
  const { checks } = loadBundleWorkspace(source).catalog;
  const build = (version: string, selectedProfiles: readonly string[]) => claude.buildClaudeBundle({
    repository: source, destination: join(root, "bundles"), sourceRevision: revision, version, policyVersion: "1",
    selectedProfiles, checks, skills: skills.map((id) => ({ id })),
  });
  const first = await build("0.1.0", []);
  const next = await build("0.1.1", ["ui-atomic"]);
  let chosen = first;
  const session = async (enabled: boolean) => {
    const trace = await claude.executeClaudeSession(profile, { model: host.model, prompt: ordinaryPrompt, signal });
    expect(trace.code).toBe(0);
    expect(trace.observation.observedModel).toBe(host.model);
    const activation = claude.assessClaudeActivation(chosen, host, trace.observation);
    if (!enabled) expect(activation.loading).toBe(false);
    return activation.outcome;
  };
  return {
    core: first.manifest.policy, updatedPolicy: next.manifest.policy, digest: first.manifest.digest, updatedDigest: next.manifest.digest,
    mechanism: "SessionStart hooks and provider request",
    async install() {
      await claude.validateClaudeBundle(profile, first, signal);
      await claude.configureClaudeProfile(profile, "local", "install", first, signal);
      expect(await claude.observeClaudeInstallation(profile, "local", signal))
        .toMatchObject({ discovered: true, selected: true, observedVersion: host.version });
    },
    async update() {
      await claude.configureClaudeProfile(profile, "local", "update", next, signal);
      chosen = next;
    },
    async disable() { await claude.configureClaudeProfile(profile, "local", "disable", undefined, signal); },
    async uninstall() { await claude.configureClaudeProfile(profile, "local", "uninstall", undefined, signal); },
    session,
    async assertPreserved() {
      expect(await readFile(user, "utf8")).toBe(userInstruction);
      expect(await readFile(project, "utf8")).toBe(projectInstruction);
      for (const file of [settings, local]) expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject(setting);
    },
    async brokenControl() {
      const inventory = await nativeJson(profile, ["plugin", "list"], signal) as { id: string; installPath: string }[];
      const installed = inventory.find(({ id }) => id === "axiom@axiom-local");
      const marketplaces = await nativeJson(profile, ["plugin", "marketplace", "list"], signal) as { name: string; path: string }[];
      const source = marketplaces.find(({ name }) => name === "axiom-local");
      expect(installed?.installPath).toBeTruthy();
      expect(source?.path).toBeTruthy();
      const paths = await Promise.all([join(installed!.installPath, "core", "AXIOMS.md"),
        join(source!.path, chosen.manifest.runtimeRoot, "core", "AXIOMS.md")].map((path) => realpath(path)));
      const originals = await Promise.all([...new Set(paths)].map(async (file) => ({ file, bytes: await readFile(file) })));
      try {
        await Promise.all(originals.map(({ file }) => writeFile(file, "Intentionally damaged disposable policy.\n")));
        const result = await session(true);
        expect(result.status).toBe("failed");
        return result;
      } finally {
        await Promise.all(originals.map(({ file, bytes }) => writeFile(file, bytes)));
      }
    },
  };
}

async function codexArtifactDigest(directory: string) {
  // Codex's native assembler does not write a shared bundle manifest. Bind every staged file.
  const inventory = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = inventory.filter((entry) => !entry.isDirectory()).map((entry) => {
    if (!entry.isFile()) throw new Error("The native Codex artifact contains a nonregular file.");
    return relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/");
  }).sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(JSON.stringify([file, createHash("sha256")
    .update(await readFile(join(directory, file))).digest("hex")]));
  return `sha256:${hash.digest("hex")}`;
}

async function codexFixture(input: Fixture): Promise<InstalledFixture> {
  const { root, workspace, source, executable, host, loopback, signal } = input;
  const profile = { program: executable, workspace, home: join(root, "codex"), userHome: join(root, "user") };
  await Promise.all([mkdir(profile.home), mkdir(profile.userHome)]);
  const user = join(profile.home, "AGENTS.md");
  const project = join(workspace, "AGENTS.md");
  const configuration = join(profile.home, "config.toml");
  const config = [
    'model_provider = "fixture"', "[model_providers.fixture]", 'name = "Disposable fixture"',
    `base_url = "${loopback.endpoint}/v1"`, 'wire_api = "responses"', "requires_openai_auth = false",
    "request_max_retries = 0", "stream_max_retries = 0", "",
  ].join("\n");
  await Promise.all([writeFile(configuration, config), writeFile(user, userInstruction), writeFile(project, projectInstruction)]);
  const catalog = loadBundleWorkspace(source).catalog;
  const build = (version: string, profiles: readonly string[]) => codex.buildCodexBundle({
    source, destination: join(root, "bundles", version), version, catalog, profiles,
  });
  const first = await build("0.1.0", []);
  const next = await build("0.1.1", ["ui-atomic"]);
  let chosen = first;
  const session = async () => {
    const response = await runCodex(profile, [
      "--ask-for-approval", "never", "exec", "--sandbox", "workspace-write", "--ephemeral", "--skip-git-repo-check",
      "--color", "never", "--json", "--model", host.model, "-",
    ], { input: ordinaryPrompt, signal });
    expect(response.code).toBe(0);
    expect(codex.parseCodexTrace(response.stdout).outcome.status).toBe("passed");
    const observed = await codex.observeCodexProfile(profile, signal);
    return observed.observedVersion === host.version && observed.selected
      && observed.contexts.includes(chosen.instructions) && chosen.skills.every((id) => observed.skills.includes(`axiom:${id}`))
      ? passed : blocked("The expected Codex policy and skills did not reach the native prompt.");
  };
  return {
    core: first.policy, updatedPolicy: next.policy, digest: await codexArtifactDigest(first.root),
    updatedDigest: await codexArtifactDigest(next.root),
    mechanism: "host AGENTS.md and skill layers observed in native debug and provider request",
    async install() {
      await codex.configureCodexProfile(profile, "install", first, signal);
      expect(await codex.observeCodexProfile(profile, signal)).toMatchObject({
        discovered: true, selected: true, observedVersion: host.version,
      });
    },
    async update() {
      await codex.configureCodexProfile(profile, "update", next, signal);
      chosen = next;
    },
    async disable() { await codex.configureCodexProfile(profile, "disable", undefined, signal); },
    async uninstall() { await codex.configureCodexProfile(profile, "uninstall", undefined, signal); },
    session,
    async assertPreserved() {
      expect(await readFile(user, "utf8")).toBe(userInstruction);
      expect(await readFile(project, "utf8")).toBe(projectInstruction);
      expect(await readFile(configuration, "utf8")).toContain(config);
    },
    async brokenControl() {
      const intact = await readFile(user, "utf8");
      try {
        await writeFile(user, codex.transformProfileInstructions(intact));
        expect((await codex.observeCodexProfile(profile, signal)).selected).toBe(true);
        const result = await session();
        expect(result.status).toBe("blocked");
        return result;
      } finally {
        await writeFile(user, intact);
      }
    },
  };
}

async function hermesFixture(input: Fixture): Promise<InstalledFixture & { profileDisclosure(): Promise<EvidenceOutcome> }> {
  const { root, workspace, source, revision, executable, host, loopback, signal } = input;
  const home = join(root, "h");
  const target = { home, profile: "qualification" };
  const environment = { OPENAI_API_KEY: "loopback-only", HERMES_DISABLE_AUTO_UPDATE: "1" };
  const native = { executable, cwd: workspace, deadline: performance.now() + 100_000, signal,
    env: { ...environment, HOME: home, HERMES_HOME: home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } };
  expect((await runHermes({ ...native, args: ["profile", "create", target.profile, "--no-alias", "--no-credentials"] })).code).toBe(0);
  expect((await runHermes({ ...native, args: ["--version"] })).stdout).toContain(`Hermes Agent v${host.version}`);
  const selected = join(home, "profiles", target.profile);
  const user = join(selected, "SOUL.md");
  const project = join(workspace, "AGENTS.md");
  const configuration = join(selected, "config.yaml");
  await Promise.all([writeFile(user, userInstruction), writeFile(project, projectInstruction),
    writeFile(configuration, "qualification_custom_setting: preserve\n"), writeFile(join(workspace, "fixture.txt"), "Fixture.\n")]);
  const { checks } = loadBundleWorkspace(source).catalog;
  const build = (version: string, selectedProfiles: readonly string[] = []) => writeBundles(join(root, "bundles"), assembleBundles(source, {
    version, sourceRevision: revision, policyVersion: "1", selectedProfiles, checks, skills: skills.map((id) => ({ id })),
    adapters: [hermes.hermesBundleAdapter],
  }))[0]!;
  const first = build("0.1.0");
  const next = build("0.1.1");
  const archive = join(root, "evidence");
  const backend = new hermes.HermesBenchmarkBackend({
    executable, profile: target, archiveDirectory: archive, provider: "custom", maxTurns: 6,
    baseUrl: loopback.endpoint + "/v1", environment,
  });
  let sequence = 0;
  const runSession = (enabled: boolean, policy: PolicyIdentity, prompt = ordinaryPrompt, timeoutMs = 24_000) =>
    backend.run({
      id: `installed-session-${++sequence}`, caseId: "native-transport", workspace, host,
      policy, prompt, mode: enabled ? "with_axiom" : "without_axiom", timeoutMs,
    }, signal);
  const session = async (enabled: boolean) => {
    const result = await runSession(enabled, first.manifest.policy);
    expect(result.host, JSON.stringify(result.outcome)).toEqual(host);
    return result.outcome;
  };
  return {
    core: first.manifest.policy, updatedPolicy: next.manifest.policy, digest: first.manifest.digest, updatedDigest: next.manifest.digest,
    mechanism: "native plugin registration and session-bound llm_request middleware",
    async install() {
      expect(hermes.changeHermesPlugin(target, { kind: "install", bundle: first.directory }).outcome).toEqual(passed);
      const nativeInventory = await runHermes({ ...native, args: ["--profile", target.profile, "plugins", "list", "--user", "--json"] });
      expect(nativeInventory.code).toBe(0);
      expect(JSON.parse(nativeInventory.stdout)).toContainEqual(expect.objectContaining({
        name: "axiom", version: first.manifest.version, status: "enabled",
      }));
    },
    async update() {
      expect(hermes.changeHermesPlugin(target, { kind: "update", bundle: next.directory }).outcome).toEqual(passed);
      expect(hermes.inspectHermesActivation(target)).toMatchObject({ bundleDigest: next.manifest.digest, enabled: true });
    },
    async disable() { expect(hermes.changeHermesPlugin(target, { kind: "disable" }).outcome).toEqual(passed); },
    async uninstall() { expect(hermes.changeHermesPlugin(target, { kind: "uninstall" }).outcome).toEqual(passed); },
    session,
    async assertPreserved() {
      expect(await readFile(user, "utf8")).toBe(userInstruction);
      expect(await readFile(project, "utf8")).toBe(projectInstruction);
      expect(await readFile(configuration, "utf8")).toContain("qualification_custom_setting: preserve");
    },
    async brokenControl() {
      const file = join(selected, "plugins", "axiom", "core", "AXIOMS.md");
      const intact = await readFile(file);
      loopback.respondWithHermesTool(async () => {
        await writeFile(file, "Intentionally damaged disposable policy.\n");
        return { name: "read_file", arguments: '{"path":"fixture.txt"}' };
      });
      try {
        const result = await session(true);
        expect(result.status).toBe("failed");
        return result;
      } finally {
        await writeFile(file, intact);
      }
    },
    async profileDisclosure() {
      const profiled = build("0.1.2", ["ui-atomic"]);
      expect(hermes.changeHermesPlugin(target, { kind: "install", bundle: profiled.directory }).outcome).toEqual(passed);
      try {
        const prompt = "Repair the catalog filter component dependency in the disposable UI graph.";
        const path = join(workspace, "ui-graph.json");
        const atom = { id: "input", level: "atom", owner: "catalog", visibility: "public", dependencies: [] } as const;
        const filter = { id: "filter", level: "molecule", owner: "catalog", visibility: "owner", dependencies: ["input"] } as const;
        const original = [{ ...atom, dependencies: ["filter"] }, filter];
        const corrected = [atom, filter];
        expect(inspectComposition(original)).toContainEqual({
          code: "non-downward-dependency", component: "input", dependency: "filter",
        });
        await writeFile(path, JSON.stringify(original));
        const id = "ui-atomic";
        const name = `axiom:profile-${id}`;
        const text = await readFile(join(source, "profiles", id, "PROFILE.md"), "utf8");
        loopback.requests.length = 0;
        loopback.respondWithHermesTool(async () => {
          loopback.respondWithHermesTool(async () => {
            const results = loopback.requests.at(-1)!.toolResults.map((raw) => JSON.parse(raw));
            expect(results).toContainEqual(expect.objectContaining({ success: true, name, file: "PROFILE.md", content: text }));
            loopback.respondWithHermesTool(async () => ({
              name: "write_file", arguments: JSON.stringify({ path, content: JSON.stringify(corrected) }),
            }));
            return { name: "read_file", arguments: JSON.stringify({ path }) };
          });
          return { name: "skill_view", arguments: JSON.stringify({ name, file_path: "PROFILE.md" }) };
        });
        const result = await runSession(true, profiled.manifest.policy, prompt, 35_000);
        expect(result.outcome).toEqual(passed);
        expect(result.host).toEqual(host);
        const firstRequest = loopback.requests[0]!.text;
        const core = (await readFile(join(source, "core", "AXIOMS.md"), "utf8")).trimEnd();
        const frames = firstRequest.split("<!-- hermes-plugin-sections:start -->\n")[1]!
          .split("\n<!-- hermes-plugin-sections:end -->")[0]!
          .replace(/^## Plugin Context: axiom\.policy-\d{3}\n<!-- hermes-plugin-section-chars:\d+ -->\n\n/gm, "");
        expect(frames).toContain(core);
        expect(frames).toContain(profiled.manifest.policy.digest);
        expect(firstRequest).toContain(prompt);
        expect(frames).toContain(name);
        expect(frames).not.toContain(text.trimEnd());
        const { session } = JSON.parse(await readFile(join(archive, result.artifacts[0]!.location), "utf8"));
        expect(hermes.inspectHermesActivation(target, session)).toMatchObject({
          coreLoaded: passed, loaded: passed, profileLoads: [{ id, outcome: passed }],
        });
        const graph = JSON.parse(await readFile(path, "utf8"));
        expect(graph).toEqual(corrected);
        expect(inspectComposition(graph)).toEqual([]);
        return result.outcome;
      } finally {
        expect(hermes.changeHermesPlugin(target, { kind: "uninstall" }).outcome).toEqual(passed);
      }
    },
  };
}

const fixtures = { claude: claudeFixture, codex: codexFixture, hermes: hermesFixture } satisfies
  Record<NativeHost, (input: Fixture) => Promise<InstalledFixture>>;

test.concurrent.each(rows)("$agent installed artifact and ordinary-session matrix", async (row) => {
  const executable = process.env[row.env];
  const source = process.cwd();
  const observedSource = await snapshotSource({ root: source });
  if (!executable || process.platform !== "linux") {
    const unavailable = blocked(!executable ? `The native CLI was not configured through ${row.env}.`
      : "This installed-host matrix declares only Linux CLI fixtures.");
    const report = assessInstalledHost({ installation: unavailable });
    expect(report.outcome.status).toBe("blocked");
    return;
  }
  const host = { agent: row.agent, version: row.version, model: row.model, surface: "cli", os: process.platform };
  const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-host-")));
  const workspace = join(root, "project");
  const loopback = await openLoopback(row.agent, row.model);
  const signal = AbortSignal.timeout(115_000);
  try {
    await mkdir(workspace);
    execFileSync("git", ["init", "--quiet"], { cwd: workspace, timeout: 3_000 });
    const fixture = await fixtures[row.agent]({
      root, workspace, source, revision: observedSource.revision ?? observedSource.digest, executable, host, loopback, signal,
    });
    const observe = async (policy?: PolicyIdentity) => {
      loopback.requests.length = 0;
      const result = await fixture.session(Boolean(policy));
      expect(loopback.requests.length).toBeGreaterThan(0);
      const request = loopback.requests[0]!;
      expect(request.model).toBe(host.model);
      expect(request.text).toContain(ordinaryPrompt);
      expect(request.text).toContain(userInstruction);
      expect(request.text).toContain(projectInstruction);
      if (policy) {
        expect(result.status).toBe("passed");
        expect(request.text).toContain(policy.digest);
        expect(request.text).toContain("# Axiom Core");
        if (policy.profiles.length > 0) {
          expect(request.text).toContain("# Atomic UI profile");
        }
        for (const skill of skills) expect(request.text).toContain(`axiom:${skill}`);
      } else {
        expect(request.text).not.toContain(fixture.core.digest);
        expect(request.text).not.toContain("# Axiom Core");
        for (const skill of skills) expect(request.text).not.toContain(`axiom:${skill}`);
      }
    };
    await observe();
    await fixture.install();
    await fixture.install();
    await observe(fixture.core);
    await fixture.update();
    await observe(fixture.updatedPolicy);
    const brokenControl = await fixture.brokenControl();
    await fixture.disable();
    await observe();
    await fixture.uninstall();
    await observe();
    await fixture.assertPreserved();
    expect(await snapshotSource({ root: source })).toEqual(observedSource);
    const observations = Object.fromEntries(transportRequirements.map((requirement) => [requirement, passed]));
    const report = assessInstalledHost(observations);
    expect(report.transport).toEqual(passed);
    expect(report.outcome.status).toBe("blocked");
    process.stdout.write(JSON.stringify({
      kind: "installed-native-loopback", source: observedSource, host, bundleDigest: fixture.digest,
      updatedBundleDigest: fixture.updatedDigest, policy: fixture.core, updatedPolicy: fixture.updatedPolicy,
      mechanism: fixture.mechanism, brokenControl, ...report,
    }) + "\n");
  } finally {
    await loopback.close();
    await rm(root, { recursive: true, force: true });
  }
}, 125_000);

test.runIf(process.env.AXIOM_HERMES_CLI && process.platform === "linux")(
  "Hermes retrieves and exercises the selected framework-independent UI profile",
  async () => {
    const row = rows.find(({ agent }) => agent === "hermes")!;
    const source = process.cwd();
    const observedSource = await snapshotSource({ root: source });
    const host = { agent: row.agent, version: row.version, model: row.model, surface: "cli", os: process.platform };
    const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-profile-")));
    const workspace = join(root, "project");
    const loopback = await openLoopback(row.agent, row.model);
    try {
      await mkdir(workspace);
      execFileSync("git", ["init", "--quiet"], { cwd: workspace, timeout: 3_000 });
      const fixture = await hermesFixture({
        root, workspace, source, revision: observedSource.revision ?? observedSource.digest,
        executable: process.env.AXIOM_HERMES_CLI!, host, loopback, signal: AbortSignal.timeout(50_000),
      });
      expect(await fixture.profileDisclosure()).toEqual(passed);
      await fixture.assertPreserved();
      expect(await snapshotSource({ root: source })).toEqual(observedSource);
    } finally {
      await loopback.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000,
);
