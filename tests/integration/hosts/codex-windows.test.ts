import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildCodexBundle, configureCodexProfile, parseCodexTrace, supportedVersion, transformProfileInstructions } from "../../../adapters/codex/src/index.js";
import { nativeVersion, runCodex } from "../../../adapters/codex/src/process.js";
import { loadBundleWorkspace } from "../../../packages/bundles/src/index.js";
import { codexDigest } from "../../../packages/cli/src/native-install.js";
import { snapshotSource } from "../../../packages/evidence/src/index.js";
import { openLoopback, ordinaryPrompt } from "./loopback.js";
import { windowsCodexEnvironment, windowsCodexFixture, windowsSandbox } from "./windows-codex.js";

const executable = process.env.AXIOM_TEST_CODEX_BINARY;
const model = "gpt-5.4";
const userInstruction = "Keep the disposable user instruction.\n";
const projectInstruction = "Keep the disposable project instruction.\n";

test.runIf(executable && process.platform === "win32")("pinned Windows Codex loads and replaces the staged Axiom artifact through its native lifecycle", async () => {
  const source = process.cwd();
  const revision = await snapshotSource({ root: source });
  const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-native-win-")));
  const userHome = join(root, "user");
  const profile = { program: executable!, workspace: join(root, "project"), home: join(root, "codex"), userHome,
    environment: windowsCodexEnvironment(userHome) };
  const loopback = await openLoopback("codex", model);
  const signal = AbortSignal.timeout(90_000);
  try {
    await Promise.all([mkdir(profile.workspace), mkdir(profile.home), mkdir(profile.userHome)]);
    const user = join(profile.home, "AGENTS.md");
    const project = join(profile.workspace, "AGENTS.md");
    const setting = join(profile.home, "config.toml");
    const url = `${loopback.endpoint}/v1`;
    await Promise.all([writeFile(user, userInstruction), writeFile(project, projectInstruction), writeFile(setting, [
      'model_provider = "fixture"', "[model_providers.fixture]", 'name = "Disposable fixture"', `base_url = "${url}"`,
      'wire_api = "responses"', "requires_openai_auth = false", "request_max_retries = 0", "stream_max_retries = 0", "", windowsSandbox,
    ].join("\n"))]);
    expect(await nativeVersion(profile, signal)).toBe(supportedVersion);
    const { catalog } = loadBundleWorkspace(source);
    const first = await buildCodexBundle({ source, destination: join(root, "first"), version: "0.1.0", catalog, profiles: [] });
    const later = await buildCodexBundle({ source, destination: join(root, "later"), version: "0.1.1", catalog, profiles: ["ui-atomic"] });
    await expect(configureCodexProfile(profile, "install", first, signal)).rejects.toThrow("version or platform is unsupported");
    const lifecycle = windowsCodexFixture(profile, root, signal);
    const observe = async () => {
      const results = loopback.requests.length;
      const native = await runCodex(profile, ["--ask-for-approval", "never", "exec", "--sandbox", "read-only",
        "--ephemeral", "--skip-git-repo-check", "--color", "never", "--json", "--model", model, "-",
      ], { input: ordinaryPrompt, signal });
      expect(native.code).toBe(0);
      expect(parseCodexTrace(native.stdout).outcome.status).toBe("passed");
      expect(loopback.requests).toHaveLength(results + 1);
      const request = loopback.requests[results]!;
      expect(request.model).toBe(model);
      expect(request.text).toContain(ordinaryPrompt);
      expect(request.text).toContain(userInstruction.trim());
      expect(request.text).toContain(projectInstruction.trim());
      return request.text;
    };
    const requireInactive = (text: string) => {
      expect(text).not.toContain("# Axiom Core");
      for (const skill of first.skills) expect(text).not.toContain(`axiom:${skill}`);
    };
    const requireActive = (text: string, bundle: typeof first) => {
      expect(text.includes(bundle.instructions)).toBe(true);
      for (const skill of bundle.skills) expect(text).toContain(`axiom:${skill}`);
    };
    requireInactive(await observe());
    await lifecycle.install(first);
    requireActive(await observe(), first);
    await lifecycle.install(later, true);
    const updated = await observe();
    requireActive(updated, later);
    expect(updated).not.toContain(first.policy.digest);

    const intact = await readFile(user, "utf8");
    try {
      await writeFile(user, transformProfileInstructions(intact));
      expect((await lifecycle.installed())?.enabled).toBe(true);
      expect(await observe()).not.toContain(later.policy.digest);
    } finally {
      await writeFile(user, intact);
    }

    await lifecycle.disable();
    requireInactive(await observe());
    await lifecycle.uninstall();
    requireInactive(await observe());
    expect(await readFile(user, "utf8")).toBe(userInstruction);
    expect(await readFile(project, "utf8")).toBe(projectInstruction);
    expect(await readFile(setting, "utf8")).toContain(`base_url = "${url}"`);
    expect(await snapshotSource({ root: source })).toEqual(revision);
    process.stdout.write(JSON.stringify({ kind: "installed-windows-codex-lifecycle-loopback", source: revision,
      host: { agent: "codex", version: supportedVersion, model, os: process.platform, architecture: process.arch, surface: "exec" },
      bundleDigest: await codexDigest(first.root), updatedBundleDigest: await codexDigest(later.root), policy: first.policy,
      updatedPolicy: later.policy, mechanism: "native local marketplace and installed AGENTS.md on the local Responses wire",
      transport: { status: "passed" }, productionInstaller: { status: "blocked", reason: "The supported adapter installer is Linux-only." },
      realModelBehavior: { status: "not_run", reason: "This fixture used a scripted localhost provider." },
      qualification: { status: "blocked", reason: "External model evidence is required." } }) + "\n");
  } finally {
    await loopback.close();
    await rm(root, { recursive: true, force: true });
  }
}, 100_000);
