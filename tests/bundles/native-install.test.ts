import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { parse } from "yaml";
import { runClaudeHook, runtimeFile } from "../../adapters/claude/src/runtime.js";
import { readBundle, verifyBundle } from "../../adapters/hermes/src/bundle.js";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const temporary: string[] = [];

function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "axiom-native-install-"));
  temporary.push(root);
  const repository = join(root, "checkout");
  mkdirSync(repository);
  const reviewed = execFileSync("git", ["archive", "--format=tar", "HEAD", "--", "core", "profiles", "skills", "LICENSE"], {
    cwd: checkout, timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
  });
  execFileSync("tar", ["-xf", "-", "-C", repository], { input: reviewed, timeout: 10_000 });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "--local", "core.autocrlf", "false");
  git("add", ".");
  git("-c", "user.name=Axiom Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false",
    "commit", "-qm", "Reviewed fixture source");
  return { repository, root, revision: git("rev-parse", "HEAD") };
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("assembles all three versioned native distributions and a reproducible Hermes pin", async () => {
  const { runNativeBundle } = await import("../../packages/cli/src/native-install.js");
  const { repository, root, revision } = createWorkspace();
  const first = join(root, "first release");
  const second = join(root, "second release");
  const options = { repository, version: "0.2.5", profiles: ["angular-nx"] };
  const a = await runNativeBundle({ ...options, output: first });
  const b = await runNativeBundle({ ...options, output: second });
  expect(a.outcome).toEqual({ status: "passed" });
  expect(b.outcome).toEqual({ status: "passed" });
  const manifest = (directory: string) => JSON.parse(readFileSync(join(directory, "axiom-distribution.json"), "utf8"));
  expect(manifest(first)).toEqual(manifest(second));
  const { hosts, policy } = manifest(first);
  expect(manifest(first)).toMatchObject({ version: "0.2.5", sourceRevision: revision });
  expect(policy.profiles.map(({ id }: { id: string }) => id).sort()).toEqual(["angular-nx", "ui-atomic"]);
  expect(Object.keys(hosts)).toEqual(["claude", "codex", "hermes"]);
  expect(hosts.hermes.commit).toMatch(/^[a-f0-9]{40}$/);
  const list = execFileSync("git", ["ls-tree", "-r", "--name-only", hosts.hermes.commit], {
    cwd: join(first, "hermes"), encoding: "utf8",
  }).split(/\r?\n/);
  expect(list).toContain("plugin.yaml");
  expect(list).toContain("axiom-bundle.json");
  expect(list).toContain("LICENSE");
  expect(list).not.toEqual(expect.arrayContaining([expect.stringMatching(/(^|\/)evals\//)]));
  expect(JSON.parse(readFileSync(join(first, "claude/.claude-plugin/marketplace.json"), "utf8")))
    .toMatchObject({ name: "axiom-local", plugins: [{ name: "axiom", version: "0.2.5" }] });
  expect(JSON.parse(readFileSync(join(first, "codex/plugins/axiom/.codex-plugin/plugin.json"), "utf8")))
    .toMatchObject({ name: "axiom", version: "0.2.5" });
  expect(readFileSync(join(first, "codex/plugins/axiom/LICENSE"), "utf8"))
    .toBe(readFileSync(join(repository, "LICENSE"), "utf8").replace(/\r\n?/g, "\n"));
  expect(a.report?.hermesUrl).toContain("first%20release");
}, 30_000);

test("rejects unreviewed source changes and preserves a caller-owned destination", async () => {
  const { runNativeBundle } = await import("../../packages/cli/src/native-install.js");
  const { repository, root } = createWorkspace();
  const output = join(root, "existing");
  mkdirSync(output);
  writeFileSync(join(output, "keep.txt"), "preserve");
  expect((await runNativeBundle({ repository, output })).outcome).toMatchObject({ status: "blocked" });
  expect(readFileSync(join(output, "keep.txt"), "utf8")).toBe("preserve");
  writeFileSync(join(repository, "core/AXIOMS.md"), "Uncommitted policy edit.\n");
  expect((await runNativeBundle({ repository, output: join(root, "dirty") })).outcome)
    .toMatchObject({ status: "blocked", reason: expect.stringMatching(/uncommitted/) });
}, 20_000);

async function nativeFixture() {
  const { runNativeBundle } = await import("../../packages/cli/src/native-install.js");
  const { repository, root } = createWorkspace();
  const output = join(root, "distribution");
  const bundle = await runNativeBundle({ repository, output, version: "0.2.5" });
  expect(bundle.outcome).toEqual({ status: "passed" });
  const home = join(root, "user");
  mkdirSync(home);
  const connectivity = Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR"].map((key) => [key, process.env[key]]));
  const env = { ...connectivity, PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"), HERMES_HOME: join(home, "hermes"), HERMES_DISABLE_AUTO_UPDATE: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", GIT_TERMINAL_PROMPT: "0" };
  const run = (binary: string, args: string[], cwd = repository) => execFileSync(binary, args, {
    cwd, env, encoding: "utf8", timeout: 35_000,
  });
  return { root, repository, output, home, env, run, report: bundle.report!, runNativeBundle };
}

test("rejects an altered Codex distribution before touching the selected profile", async () => {
  const { runCodexLifecycle } = await import("../../packages/cli/src/native-install.js");
  const { output, repository, root } = await nativeFixture();
  writeFileSync(join(output, "codex/plugins/axiom/axiom-policy.txt"), "Altered bundle policy.\n");
  const home = join(root, "unmodified-profile");
  const result = await runCodexLifecycle({ distribution: output, action: "install", home, workspace: repository,
    program: join(root, "unavailable-codex") });
  expect(result.outcome).toMatchObject({ status: "blocked", reason: expect.stringMatching(/digest/) });
  expect(existsSync(home)).toBe(false);
}, 20_000);

test.runIf(Boolean(process.env.AXIOM_TEST_CLAUDE_BINARY) && process.platform === "linux")(
  "installs, updates and rolls back the staged Claude marketplace while preserving unrelated settings", async () => {
    const { output, repository, root, env, run, report, runNativeBundle } = await nativeFixture();
    const program = process.env.AXIOM_TEST_CLAUDE_BINARY!;
    mkdirSync(env.CLAUDE_CONFIG_DIR);
    const settings = join(env.CLAUDE_CONFIG_DIR, "settings.json");
    writeFileSync(settings, '{"env":{"AXIOM_TEST_UNRELATED":"keep"}}\n');
    const installed = () => JSON.parse(run(program, ["plugin", "list", "--json"]))
      .find(({ id }: { id: string }) => id === "axiom@axiom-local");
    expect(run(program, ["--version"])).toContain(report.hosts.claude.hostVersion);
    run(program, ["plugin", "marketplace", "add", join(output, "claude")]);
    run(program, ["plugin", "install", "axiom@axiom-local", "--scope", "local"]);
    expect(installed()).toMatchObject({ version: "0.2.5", scope: "local", enabled: true });
    const previous = installed().installPath;
    const previousManifest = readFileSync(join(previous, ".claude-plugin", "plugin.json"));
    const update = join(root, "updated");
    expect((await runNativeBundle({ repository, output: update, version: "0.2.6" })).outcome).toEqual({ status: "passed" });
    const marketplace = join(output, "claude");
    renameSync(marketplace, join(root, "previous-claude"));
    cpSync(join(update, "claude"), marketplace, { recursive: true });
    run(program, ["plugin", "marketplace", "update", "axiom-local"]);
    run(program, ["plugin", "update", "axiom@axiom-local", "--scope", "local"]);
    expect(installed()).toMatchObject({ version: "0.2.6", scope: "local", enabled: true });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toMatchObject({ env: { AXIOM_TEST_UNRELATED: "keep" } });
    renameSync(marketplace, join(root, "newer-claude"));
    renameSync(join(root, "previous-claude"), marketplace);
    run(program, ["plugin", "marketplace", "update", "axiom-local"]);
    run(program, ["plugin", "update", "axiom@axiom-local", "--scope", "local"]);
    expect(installed()).toMatchObject({ version: "0.2.5", scope: "local", enabled: true, installPath: previous });
    expect(readFileSync(join(previous, ".claude-plugin", "plugin.json"))).toEqual(previousManifest);
    expect(readFileSync(join(previous, runtimeFile))).toEqual(readFileSync(join(marketplace, "plugins", "axiom", runtimeFile)));
    const runtime = await runClaudeHook(previous, { hook_event_name: "SessionStart", source: "startup" });
    expect(runtime).toMatchObject({ outcome: { status: "passed" }, evidence: { policy: report.policy } });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toMatchObject({ env: { AXIOM_TEST_UNRELATED: "keep" } });
    run(program, ["plugin", "disable", "axiom@axiom-local", "--scope", "local"]);
    run(program, ["plugin", "uninstall", "axiom@axiom-local", "--scope", "local"]);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toMatchObject({ env: { AXIOM_TEST_UNRELATED: "keep" } });
  }, 50_000,
);

test.runIf(Boolean(process.env.AXIOM_TEST_CODEX_BINARY) && process.platform === "linux")(
  "rolls back the staged Codex plugin and observes its original policy bridge", async () => {
    const { codexDigest, runCodexLifecycle } = await import("../../packages/cli/src/native-install.js");
    const { output, repository, root, home, env, run, report, runNativeBundle } = await nativeFixture();
    const program = process.env.AXIOM_TEST_CODEX_BINARY!;
    mkdirSync(env.CODEX_HOME);
    const instructions = join(env.CODEX_HOME, "AGENTS.md");
    const original = "Retain this existing profile instruction.\n";
    writeFileSync(instructions, original);
    const target = { distribution: output, home: env.CODEX_HOME, userHome: home, workspace: repository, program };
    expect(run(program, ["--version"])).toContain(report.hosts.codex.hostVersion);
    expect((await runCodexLifecycle({ ...target, action: "install" })).outcome).toEqual({ status: "passed" });
    const prompt = run(program, ["debug", "prompt-input"]);
    expect(prompt).toContain(report.policy.digest);
    expect(prompt).toContain("axiom:verify");
    expect(prompt).toContain(original.trim());
    const distribution = join(root, "updated");
    const update = await runNativeBundle({ repository, output: distribution, version: "0.2.6", profiles: ["angular-nx"] });
    expect(update.outcome).toEqual({ status: "passed" });
    expect((await runCodexLifecycle({ ...target, distribution, action: "update" })).outcome).toEqual({ status: "passed" });
    const upgraded = run(program, ["debug", "prompt-input"]);
    expect(upgraded).toContain(update.report!.policy.digest);
    expect(upgraded).toContain(original.trim());
    const rollback = await runCodexLifecycle({ ...target, action: "update" });
    expect(rollback).toMatchObject({ outcome: { status: "passed" }, report: { version: "0.2.5" } });
    const restored = run(program, ["debug", "prompt-input"]);
    expect(restored).toContain(report.policy.digest);
    expect(restored).toContain(original.trim());
    expect(restored).not.toContain(update.report!.policy.digest);
    const inventory = JSON.parse(run(program, ["plugin", "marketplace", "list", "--json"]));
    const marketplace = inventory.marketplaces.find(({ name }: { name: string }) => name === "axiom-local");
    expect(await codexDigest(marketplace.root)).toBe(report.hosts.codex.digest);
    expect((await runCodexLifecycle({ ...target, action: "disable" })).outcome).toEqual({ status: "passed" });
    expect(readFileSync(instructions, "utf8")).toBe(original);
    expect((await runCodexLifecycle({ ...target, action: "uninstall" })).outcome).toEqual({ status: "passed" });
    expect(readFileSync(instructions, "utf8")).toBe(original);
  }, 50_000,
);

test.runIf(Boolean(process.env.AXIOM_HERMES_CLI) && process.platform === "linux")(
  "installs, updates and rolls back the staged Hermes Git artifact at exact commits", async () => {
    const { output, repository, root, env, run, report, runNativeBundle } = await nativeFixture();
    const program = process.env.AXIOM_HERMES_CLI!;
    expect(run(program, ["--version"])).toContain(report.hosts.hermes.hostVersion);
    run(program, ["profile", "create", "qualification", "--no-alias", "--no-credentials"]);
    const native = (...args: string[]) => run(program, ["--profile", "qualification", "plugins", ...args]);
    const profile = join(env.HERMES_HOME, "profiles", "qualification");
    const soul = join(profile, "SOUL.md");
    const config = join(profile, "config.yaml");
    const unrelated = { model: { default: "fixture-model" } };
    writeFileSync(soul, "Preserve this unrelated profile instruction.\n");
    writeFileSync(config, JSON.stringify(unrelated));
    native("install", report.hermesUrl, "--ref", report.hosts.hermes.commit, "--no-enable");
    native("enable", "axiom");
    expect(JSON.parse(native("list", "--user", "--json"))).toContainEqual(expect.objectContaining({
      name: "axiom", version: "0.2.5", status: "enabled",
    }));

    const updated = await runNativeBundle({ repository, output: join(root, "updated"), version: "0.2.6" });
    expect(updated.outcome).toEqual({ status: "passed" });
    const next = updated.report!.hosts.hermes.commit;
    run("git", ["--git-dir", join(output, "hermes"), "fetch", "--no-tags", join(root, "updated", "hermes"),
      `${next}:refs/heads/staged-0.2.6`]);
    native("install", report.hermesUrl, "--force", "--ref", next, "--enable");
    expect(JSON.parse(native("list", "--user", "--json"))).toContainEqual(expect.objectContaining({
      name: "axiom", version: "0.2.6", status: "enabled",
    }));
    expect(parse(readFileSync(config, "utf8"))).toMatchObject(unrelated);
    expect(readFileSync(soul, "utf8")).toBe("Preserve this unrelated profile instruction.\n");
    native("install", report.hermesUrl, "--force", "--ref", report.hosts.hermes.commit, "--enable");
    expect(JSON.parse(native("list", "--user", "--json"))).toContainEqual(expect.objectContaining({
      name: "axiom", version: "0.2.5", status: "enabled",
    }));
    const plugin = join(profile, "plugins", "axiom");
    const installedBundle = readBundle(plugin);
    expect(installedBundle.digest).toBe(report.hosts.hermes.digest);
    verifyBundle(plugin, installedBundle);
    expect(parse(readFileSync(config, "utf8"))).toMatchObject(unrelated);
    expect(readFileSync(soul, "utf8")).toBe("Preserve this unrelated profile instruction.\n");
    native("remove", "axiom");
    expect(JSON.parse(native("list", "--user", "--json"))).not.toContainEqual(expect.objectContaining({ name: "axiom" }));
  }, 120_000,
);
