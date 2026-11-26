import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import type { HostIdentity, PolicyIdentity } from "@axiom/contracts";
import { buildCodexBundle, configureCodexProfile, supportedVersion } from "../../../adapters/codex/src/index.js";
import { nativeVersion, runCodex } from "../../../adapters/codex/src/process.js";
import { openHermesGateway, runHermes } from "../../../adapters/hermes/src/process.js";
import { changeHermesPlugin, hermesBundleAdapter, hermesVersion, inspectHermesActivation } from "../../../adapters/hermes/src/index.js";
import { assembleBundles, loadBundleWorkspace, writeBundles } from "../../../packages/bundles/src/index.js";
import { codexDigest } from "../../../packages/cli/src/native-install.js";
import { shellLiteral } from "./native-account.js";

export interface SettledFixture {
  root: string;
  repository: string;
  revision: string;
  workspace: string;
  program: string;
  prompt: string;
  model: string;
  endpoint: string;
  journal: string;
  signal: AbortSignal;
}

interface StartedFixture {
  host: HostIdentity;
  policy: PolicyIdentity;
  bundleDigest: string;
  output: string;
}

function hookCommand({ repository, workspace, journal }: SettledFixture) {
  const observer = join(repository, "tests", "integration", "hosts", "native-command-hook.mjs");
  return [process.execPath, observer, workspace, journal].map(shellLiteral).join(" ");
}

export async function codexSettledFixture(input: SettledFixture): Promise<StartedFixture> {
  const { root, workspace, program, prompt, model, endpoint, repository, signal } = input;
  const profile = { program, workspace, home: join(root, "codex"), userHome: join(root, "user") };
  await Promise.all([mkdir(profile.home), mkdir(profile.userHome)]);
  expect(await nativeVersion(profile, signal)).toBe(supportedVersion);
  const configuration = join(profile.home, "config.toml");
  await writeFile(configuration, [
    'model_provider = "fixture"', "[features]", "hooks = true", "apps = false",
    "[shell_environment_policy.set]", 'NODE_OPTIONS = "--test-isolation=none --test-reporter=tap"',
    "[model_providers.fixture]", 'name = "Disposable fixture"', "base_url = " + JSON.stringify(endpoint + "/v1"),
    'wire_api = "responses"', "requires_openai_auth = false", "request_max_retries = 0", "stream_max_retries = 0", "",
  ].join("\n"));
  const bundle = await buildCodexBundle({ source: repository, destination: join(root, "bundle"), version: "0.1.0",
    catalog: loadBundleWorkspace(repository).catalog, profiles: [] });
  await configureCodexProfile(profile, "install", bundle, signal);

  const command = hookCommand(input);
  const hooks = [{ matcher: "^Bash$", hooks: [{ type: "command", command }] }];
  await writeFile(join(profile.home, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: hooks, PostToolUse: hooks } }));
  let listed: { key: string; currentHash: string; command: string }[] = [];
  const listing = await runCodex(profile, ["app-server", "--stdio"], { signal, experimentalApi: true,
    onLine(line, send, end) {
      const event = JSON.parse(line);
      if (event.id === 1 && event.result) {
        send({ method: "initialized" });
        send({ id: 5, method: "hooks/list", params: { cwds: [workspace] } });
      }
      if (event.id === 5) {
        listed = event.result?.data?.flatMap((entry: { hooks?: typeof listed }) => entry.hooks ?? []) ?? [];
        end();
      }
    },
  });
  expect(listing.code).toBe(0);
  expect(listed).toHaveLength(2);
  expect(listed.every((item) => item.command === command && item.currentHash && item.key)).toBe(true);
  await appendFile(configuration, listed.map(({ key, currentHash }) => "\n[hooks.state." + JSON.stringify(key)
    + "]\ntrusted_hash = " + JSON.stringify(currentHash) + "\n").join(""));
  const turn = await runCodex(profile, ["--ask-for-approval", "never", "exec", "--sandbox", "workspace-write",
    "--ephemeral", "--color", "never", "--json", "--model", model, "-"], { input: prompt, signal });
  expect(turn.code).toBe(0);
  return { host: { agent: "codex", version: supportedVersion, model, surface: "exec", os: "linux" },
    policy: bundle.policy, bundleDigest: await codexDigest(bundle.root), output: turn.stdout };
}

export async function hermesSettledFixture(input: SettledFixture): Promise<StartedFixture> {
  const { root, workspace, program, prompt, model, endpoint, repository, revision, signal } = input;
  const home = join(root, "hermes");
  const profile = "receipt-check";
  const target = { home, profile };
  const selected = join(home, "profiles", profile);
  await mkdir(home);
  const command = { executable: program, cwd: workspace, signal, deadline: performance.now() + 80_000, env: {
    PATH: process.env.PATH!, HOME: home, HERMES_HOME: home, HERMES_TUI_GATEWAY_URL: "", HERMES_NO_SYSTEMD: "1",
    OPENAI_API_KEY: "loopback-only", HERMES_DISABLE_AUTO_UPDATE: "1", HERMES_DISABLE_LAZY_INSTALLS: "1",
    AXIOM_HERMES_NODE: process.execPath, NODE_OPTIONS: "--test-reporter=tap",
  } };
  const launch = (args: string[], input?: string) =>
    runHermes({ ...command, args, ...(input === undefined ? {} : { input }) });
  const version = await launch(["--version"]);
  expect(version.code).toBe(0);
  expect(version.stdout).toContain(hermesVersion);
  expect((await launch(["profile", "create", profile, "--no-alias", "--no-credentials", "--no-skills"])).code).toBe(0);
  const hook = { matcher: "^(terminal|read_file|write_file)$", timeout: 10, command: hookCommand(input) };
  await writeFile(join(selected, "config.yaml"), JSON.stringify({
    gateway: { standalone: true }, hooks_auto_accept: true,
    model: { default: model, provider: "custom", base_url: endpoint + "/v1", context_length: 128000 },
    terminal: { backend: "local", cwd: workspace }, platform_toolsets: { cli: ["terminal", "file", "skills"] },
    hooks: { pre_tool_call: [{ ...hook, fail_closed: true }], post_tool_call: [hook] },
    auxiliary: { title_generation: { enabled: false } },
  }));
  const { catalog, skills } = loadBundleWorkspace(repository);
  const [bundle] = writeBundles(join(root, "bundle"), assembleBundles(repository, {
    version: "0.1.0", sourceRevision: revision, policyVersion: catalog.core.version, selectedProfiles: [],
    checks: catalog.checks, skills, adapters: [hermesBundleAdapter],
  }));
  if (!bundle) throw new Error("The Hermes artifact could not be assembled.");
  expect(changeHermesPlugin(target, { kind: "install", bundle: bundle.directory }).outcome.status).toBe("passed");
  const gateway = await openHermesGateway({ ...command,
    args: ["--profile", profile, "gateway", "run", "--no-supervise", "--external-supervisor"] }, selected, profile, true);
  if ("interrupted" in gateway) throw new Error("The native Hermes fixture could not start its local gateway.");
  try {
    const result = await launch(["--profile", profile, "chat", "--query-file", "-", "--format", "stream-json",
      "--model", model, "--provider", "custom", "--max-turns", "12", "--toolsets", "terminal,file,skills",
      "--base-url", endpoint + "/v1"], prompt);
    expect(result.code).toBe(0);
    const completed = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
      .find(({ type }) => type === "result");
    expect(completed?.session_id).toBeTruthy();
    expect(inspectHermesActivation(target, completed.session_id).loaded.status).toBe("passed");
    return { host: { agent: "hermes", version: hermesVersion, model, surface: "named-profile-cli", os: "linux" },
      policy: bundle.manifest.policy, bundleDigest: bundle.manifest.digest, output: result.stdout };
  } finally {
    await gateway.stop();
  }
}
