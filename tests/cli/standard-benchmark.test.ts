import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { assembleBundles, loadBundleWorkspace, writeBundles } from "../../packages/bundles/src/index.js";
import { createHermesAccountBackend } from "../../adapters/hermes/src/standard.js";
import { hermesBundleAdapter, hermesVersion } from "../../adapters/hermes/src/bundle.js";
import { reviewNativeBenchmark } from "../../packages/cli/src/benchmark-review.js";
import { runStandardArchive } from "../../packages/cli/src/standard-benchmark.js";
import { openLoopback } from "../integration/hosts/loopback.js";

const repository = process.cwd();
const program = process.env.AXIOM_HERMES_CLI;
const host = { agent: "hermes", version: hermesVersion, model: "fixture-model", os: process.platform, surface: "cli" };
const patchedCommand = 'import { formatSummary } from "./summary-format.mjs";\nexport function run(input) { return formatSummary(input); }\n';

test("records positive standard behavior separately from hard-budget and qualification evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "axiom-standard-replay-"));
  try {
    const options = { repository, evidenceDirectory: root, allowNative: true, timeoutSeconds: 30, repetitions: 1 };
    const configure = vi.fn(async (archive: Parameters<Parameters<typeof runStandardArchive>[3]>[0]) => {
      const { catalog, skills } = loadBundleWorkspace(archive.baseline.directory);
      const [bundle] = assembleBundles(archive.baseline.directory, {
        version: "0.1.0", sourceRevision: archive.baselineRef, policyVersion: catalog.core.version, selectedProfiles: [],
        checks: catalog.checks, skills, adapters: [hermesBundleAdapter],
      });
      return { policy: bundle!.manifest.policy, bundleDigest: bundle!.manifest.digest, backend: {
        async run(request: { id: string; workspace: string }) {
          await writeFile(join(request.workspace, "command.mjs"), patchedCommand);
          return { requestId: request.id, outcome: { status: "passed" as const }, host, durationMs: 2, artifacts: [],
            usage: { metering: "reported" as const, inputTokens: 1, outputTokens: 1 } };
        },
      } };
    });
    const unauthorized = await runStandardArchive({ ...options, allowNative: false }, host, "injected", configure);
    expect(unauthorized.outcome.status).toBe("blocked");
    expect(configure).not.toHaveBeenCalled();
    const unavailable = await runStandardArchive({ ...options, caseIds: ["resolve-format-decision"] }, host, "injected", configure);
    expect(unavailable.outcome).toMatchObject({ status: "blocked", reason: expect.stringMatching(/cannot independently evaluate/) });
    expect(configure).not.toHaveBeenCalled();
    const result = await runStandardArchive(options, host, "injected", configure);
    expect(result).toMatchObject({
      outcome: { status: "passed" }, report: { mode: "standard", qualification: { status: "blocked" },
        hardBudgetEnforcement: "unavailable", metering: { metering: "unknown" } },
    });
    if (!("report" in result) || !result.report) throw new Error("Expected a standard receipt.");
    expect(result.report.report.attempts.map(({ runtime, execution }) => [runtime, execution?.usage.metering])).toEqual([
      ["native", "reported"], ["native", "reported"],
    ]);
    const review = await reviewNativeBenchmark(repository, result.report.evidenceDirectory, result.report.evidenceDigest);
    expect(review).toMatchObject({ outcome: { status: "passed" }, report: { mode: "standard", qualification: { status: "blocked" },
      provider: "injected", hardBudgetEnforcement: "unavailable", benchmarkOutcome: { status: "passed" } } });
    const cancellation = new AbortController();
    cancellation.abort();
    expect((await runStandardArchive(options, host, "injected", configure, cancellation.signal)).outcome.status).toBe("blocked");
    expect(configure).toHaveBeenCalledTimes(1);
    const active = new AbortController();
    const results = await runStandardArchive({ ...options, repetitions: 2 }, host, "injected", async (archive) => {
      const { policy, bundleDigest } = await configure(archive);
      return { policy, bundleDigest, backend: {
        async run(request, signal) {
          active.abort();
          signal.throwIfAborted();
          throw new Error(`Cancelled attempt ${request.id} was not stopped.`);
        },
      } };
    }, active.signal);
    expect(results).toMatchObject({ outcome: { status: "blocked" }, report: { report: { attempts: [
      { outcome: { status: "blocked" } }, ...Array.from({ length: 3 }, () => ({ outcome: { status: "not_run" } })),
    ] } } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("replays the graded arm when a completed native arm could not be captured", async () => {
  const root = await mkdtemp(join(tmpdir(), "axiom-standard-capture-"));
  const privateMarker = "private-delivered-artifact-canary";
  try {
    const codex = { ...host, agent: "codex", version: "0.172.0-alpha.2" };
    const digest = `sha256:${"c".repeat(64)}`;
    const result = await runStandardArchive({
      repository, evidenceDirectory: root, allowNative: true, timeoutSeconds: 15, repetitions: 1,
    }, codex, "injected", async () => ({
      policy: { version: "1", digest, profiles: [] }, bundleDigest: digest,
      backend: { async run(request) {
        if (request.mode === "with_axiom") await writeFile(join(request.workspace, "command.mjs"), patchedCommand);
        else await writeFile(join(request.workspace, ".git"), privateMarker);
        return { requestId: request.id, host: codex, outcome: { status: "passed" }, durationMs: 2, artifacts: [],
          usage: { metering: "reported", inputTokens: 1, outputTokens: 1 } };
      } },
    }));
    expect(result.outcome.status).toBe("blocked");
    if (!("report" in result) || !result.report) throw new Error("Expected the standard benchmark archive.");
    const { evidenceDirectory, evidenceDigest, observations, report } = result.report;
    const [graded, uncaptured] = report.attempts;
    expect(graded?.outcome.status).toBe("passed");
    expect(uncaptured).toMatchObject({ mode: "without_axiom", execution: { outcome: { status: "passed" } },
      outcome: { status: "blocked", reason: "The delivered fixture contains Git metadata." },
      assertions: [{ outcome: { status: "not_run" } }, { outcome: { status: "not_run" } }],
    });
    expect(Object.keys(observations)).toEqual([graded?.id]);
    expect((await readdir(evidenceDirectory)).sort()).toEqual(["acceptance", "benchmark.json", `${graded!.id}.grading.json`].sort());
    expect(await readFile(join(evidenceDirectory, "benchmark.json"), "utf8")).not.toContain(privateMarker);
    const replay = await reviewNativeBenchmark(repository, evidenceDirectory, evidenceDigest);
    expect(replay).toMatchObject({ outcome: { status: "blocked" }, report: { qualification: { status: "blocked" }, reviews: [
      { id: graded?.id, assertions: [expect.objectContaining({ outcome: { status: "passed" } }),
        expect.objectContaining({ outcome: { status: "passed" } })] },
      { id: uncaptured?.id, outcome: { status: "not_run" } },
    ] } });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);

test.runIf(Boolean(program) && process.platform === "linux")("starts the pinned Hermes Codex route using a default-profile login", async () => {
  const root = await mkdtemp(join(tmpdir(), "axiom-hermes-codex-native-"));
  const authHome = join(root, "auth");
  const workspace = join(root, "workspace");
  const archiveDirectory = join(root, "archive");
  const launcher = join(root, "hermes-loopback");
  const model = "gpt-6.2-sol";
  const scratchBearer = "synthetic-default-profile-access-token";
  const credentials = JSON.stringify({ version: 1, credential_pool: {
    "openai-codex": [{ id: "fixture", label: "Fixture login", auth_type: "oauth", priority: 0, source: "manual:device_code",
      access_token: scratchBearer, refresh_token: "synthetic-default-profile-refresh-token" }],
  } });
  const server = await openLoopback("codex", model);
  const shellLiteral = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  try {
    await Promise.all([mkdir(authHome), mkdir(workspace)]);
    await writeFile(join(authHome, "auth.json"), credentials, { mode: 0o600 });
    // Substitute only the provider URL in this local launcher. Keep Hermes's real Codex transport and auth checks.
    await writeFile(launcher, ["#!/bin/sh", `export HERMES_CODEX_BASE_URL=${shellLiteral(server.endpoint + "/backend-api/codex")}`,
      `exec ${shellLiteral(await realpath(program!))} "$@"`, ""].join("\n"), { mode: 0o700 });
    const backend = createHermesAccountBackend({ executable: launcher, authHome, archiveDirectory, bundle: join(root, "unused-bundle") });
    const result = await backend.run({ id: "codex-route", caseId: "fixture", prompt: "Acknowledge the disposable transport fixture.",
      workspace, timeoutMs: 45_000, mode: "without_axiom", host: { ...host, model },
      policy: { version: "1", digest: `sha256:${"0".repeat(64)}`, profiles: [] },
    }, new AbortController().signal);
    expect(result.outcome).toEqual({ status: "passed" });
    expect(server.requests.map((request) => request.model)).toEqual([model]);
    expect(result.artifacts).toEqual([expect.objectContaining({ kind: "hermes-trace" })]);
    const trace = await readFile(join(archiveDirectory, result.artifacts[0]!.location), "utf8");
    expect(JSON.parse(trace)).toMatchObject({ model, session: expect.any(String), exitCode: 0 });
    expect(trace).not.toContain(scratchBearer);
    expect(await readFile(join(authHome, "auth.json"), "utf8")).toBe(credentials);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 55_000);

test.runIf(Boolean(program) && process.platform === "linux")("Hermes standard mode uses standalone profiles, guards paths and replays paired native edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "axiom-hermes-account-"));
  const home = join(root, "auth");
  const canary = join(root, "private.txt");
  const credentials = JSON.stringify({ version: 1, credential_pool: {
    "openai-codex": [{ id: "fixture", label: "Fixture login", auth_type: "oauth", priority: 0, source: "manual:device_code",
      access_token: "opaque-dummy-native-oauth", refresh_token: "opaque-dummy-native-refresh" }],
  } }) + "\n";
  const server = await openLoopback("hermes", host.model, ({ text, toolResults }) => {
    const observed = text.includes("# Axiom Core");
    const calls = [
      ...(observed ? [{ name: "read_file", arguments: JSON.stringify({ path: canary }) },
        { name: "write_file", arguments: JSON.stringify({ path: canary, content: "corrupt" }) }] : []),
      { name: "read_file", arguments: '{"path":"command.mjs"}' },
      { name: "write_file", arguments: JSON.stringify({ path: "command.mjs", content: patchedCommand }) },
    ];
    return calls[toolResults.length];
  });
  try {
    await mkdir(home);
    await writeFile(join(home, "auth.json"), credentials, { mode: 0o600 });
    await writeFile(join(home, "config.yaml"), "gateway:\n  multiplex: true\n");
    await writeFile(join(home, "SOUL.md"), "Private default profile instruction.");
    await writeFile(canary, "Private verifier canary content.");
    const result = await runStandardArchive({
      repository, evidenceDirectory: join(root, "evidence"), allowNative: true, timeoutSeconds: 90, repetitions: 1,
    }, host, "injected", async (archive, scratch) => {
      const source = archive.baseline.directory;
      const { catalog, skills } = loadBundleWorkspace(source);
      const [bundle] = writeBundles(scratch, assembleBundles(source, {
        version: "0.1.0", sourceRevision: archive.baselineRef, policyVersion: catalog.core.version,
        selectedProfiles: [], checks: catalog.checks, skills, adapters: [hermesBundleAdapter],
      }));
      return { policy: bundle!.manifest.policy, bundleDigest: bundle!.manifest.digest, backend: createHermesAccountBackend({
        executable: program!, authHome: home, archiveDirectory: archive.evidenceDirectory, bundle: bundle!.directory,
        loopback: server.endpoint + "/v1",
      }) };
    });
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: { status: "passed" },
      report: { qualification: { status: "blocked" }, metering: { metering: "unknown" } },
    });
    if (!("report" in result) || !result.report) throw new Error("Expected native Hermes receipt.");
    expect((await reviewNativeBenchmark(repository, result.report.evidenceDirectory, result.report.evidenceDigest)).outcome.status).toBe("passed");
    expect(server.requests.some(({ toolResults }) => toolResults.some((item) => item.includes("only inside its disposable fixture")))).toBe(true);
    expect(server.requests.every(({ text }) => !text.includes("Private default profile instruction.") &&
      !text.includes("Private verifier canary content.") && !text.includes("opaque-dummy-native-oauth"))).toBe(true);
    expect(await readFile(canary, "utf8")).toBe("Private verifier canary content.");
    expect(await readFile(join(home, "auth.json"), "utf8")).toBe(credentials);
    expect(await readFile(join(home, "config.yaml"), "utf8")).toBe("gateway:\n  multiplex: true\n");
    await expect(readFile(join(home, "gateway_state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 100_000);
