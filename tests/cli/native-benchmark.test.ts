import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { launchClaudeSandbox } from "../../packages/cli/src/claude-sandbox.js";
import { reviewNativeBenchmark } from "../../packages/cli/src/benchmark-review.js";
import { defaultBenchmarkLimits, runNativeBenchmark, runTrustedClaude } from "../../packages/cli/src/native-benchmark.js";
import { benchmarkModel, openProviderBudget } from "../../packages/cli/src/provider-budget.js";
import { benchmarkRevision, prepareReviewedBaseline, requireCleanBenchmarkRevision } from "../../packages/cli/src/reviewed-baseline.js";
import { openLoopback } from "../integration/hosts/loopback.js";

test("requires paid authorization before probing an operator profile or provider", async () => {
  const transport = vi.spyOn(globalThis, "fetch");
  try {
    const result = await runNativeBenchmark("claude", { ...defaultBenchmarkLimits, allowPaid: false, repository: "/missing" });
    if (process.platform === "linux") expect(result.outcome).toMatchObject({ status: "blocked", reason: expect.stringContaining("--allow-paid") });
    else expect(result.outcome.status).toBe("blocked");
    expect(transport).not.toHaveBeenCalled();
  } finally { transport.mockRestore(); }
});

test("refuses an immutable benchmark receipt for a dirty checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "axiom-dirty-checkout-"));
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: root });
  try {
    await git("init", "--quiet");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "reviewed");
    await expect(requireCleanBenchmarkRevision(root)).resolves.toMatch(/^[a-f0-9]{40}$/);
    await writeFile(join(root, "untracked.txt"), "changed");
    await expect(requireCleanBenchmarkRevision(root)).rejects.toThrow(/uncommitted/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.runIf(process.platform === "linux")("keeps the operator credential out of Git status helpers", async () => {
  const root = await mkdtemp(join(tmpdir(), "axiom-git-environment-"));
  const repository = join(root, "checkout");
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: repository });
  try {
    await mkdir(repository);
    await git("init", "--quiet");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "reviewed");
    const sentinel = join(root, "credential-visible");
    const hook = join(root, "fsmonitor");
    await writeFile(hook, "#!/bin/sh\n[ -z \"$ANTHROPIC_API_KEY\" ] || touch '" + sentinel + "'\nprintf 'token\\0'\n", { mode: 0o700 });
    await git("config", "core.fsmonitor", hook);
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-canary");
    await expect(requireCleanBenchmarkRevision(repository)).resolves.toMatch(/^[a-f0-9]{40}$/);
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

const sandbox = process.platform === "linux" && process.env.AXIOM_TEST_BWRAP === "1";
test.runIf(sandbox)("the sandbox hides verifier files and credentials and denies direct egress", async () => {
  const folder = await mkdtemp("/tmp/axiom-isolation-");
  const workspace = join(folder, "fixture");
  const home = join(folder, "profile");
  const verifier = join(folder, "verifier-only");
  await Promise.all([mkdir(workspace), mkdir(home), writeFile(verifier, "private grader")]);
  const denied = createServer((client) => client.end("should never reach the sandbox"));
  await new Promise<void>((resolve) => denied.listen(0, "127.0.0.1", resolve));
  const { port } = denied.address() as { port: number };
  const broker = await openProviderBudget(join(folder, "budget.sock"), 300_000, 100, async () => {
    throw new Error("a connectivity probe must never issue model calls");
  });
  try {
    const profile = { program: process.execPath, workspace, home: join(home, "claude"), userHome: join(home, "user") };
    const source = `const fs=require('node:fs');const net=require('node:net');
      if(fs.existsSync(${JSON.stringify(verifier)}) || process.env.CREDENTIAL_CANARY) process.exit(2);
      const socket=net.connect(${port},'127.0.0.1');socket.once('connect',()=>process.exit(3));
      socket.once('error',()=>{fs.writeFileSync('sandbox-evidence','isolated');process.exit(0)});`;
    const launch = launchClaudeSandbox(broker.socketPath)(profile, ["-e", source], { CREDENTIAL_CANARY: "hidden" });
    await promisify(execFile)(launch.program, [...launch.args], { env: launch.env, timeout: 8_000 });
    expect(await readFile(join(workspace, "sandbox-evidence"), "utf8")).toBe("isolated");
    expect(broker.usage()).toEqual({ metering: "reported", inputTokens: 0, outputTokens: 0 });
  } finally {
    await broker.close();
    await new Promise<void>((resolve) => denied.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  }
});

const program = process.env.AXIOM_TEST_CLAUDE_BINARY;
test.runIf(sandbox && program)("runs paired pinned Claude trials through the isolated budget and independent grader", async () => {
  const repository = process.cwd();
  const revision = await benchmarkRevision(repository);
  const temporary = await mkdtemp("/tmp/axiom-isolated-trials-");
  const baseline = await prepareReviewedBaseline(repository, temporary, revision, { baselineRef: revision });
  const server = await openLoopback("claude", benchmarkModel);
  try {
    const options = { ...defaultBenchmarkLimits, repository, program: program!, allowPaid: true, evidenceDirectory: join(temporary, "evidence") };
    await expect(runTrustedClaude({ ...options, caseIds: ["preserve-delegated-requirements"] }, baseline, revision, revision,
      async () => { throw new Error("Unsupported grading must be rejected before a model call."); }))
      .rejects.toThrow(/cannot independently evaluate/);
    const result = await runTrustedClaude({
      ...options,
      caseIds: ["reuse-summary-formatter", "report-unavailable-preview"],
    }, baseline, revision, revision, (body, signal) => fetch(server.endpoint + "/v1/messages", {
      method: "POST", body: JSON.stringify(body), signal,
    }));
    expect(result.report.attempts.map(({ execution, outcome }) => ({
      native: execution?.outcome, grade: outcome.status,
    })), JSON.stringify(result)).toEqual([
      { native: { status: "passed" }, grade: "failed" }, { native: { status: "passed" }, grade: "failed" },
      { native: { status: "passed" }, grade: "failed" }, { native: { status: "passed" }, grade: "failed" },
    ]);
    for (const attempt of result.report.attempts.slice(2)) {
      expect(attempt.assertions[0]?.outcome).toMatchObject({
        status: "failed", reason: expect.stringMatching(/verification record.*missing/i),
      });
    }
    expect(result.metering).toEqual({ metering: "reported", inputTokens: 36, outputTokens: 12 });
    expect(server.requests).toHaveLength(4);
    expect(server.requests.filter(({ text }) => text.includes("# Axiom Core"))).toHaveLength(2);
    expect(Object.keys(result.observations)).toHaveLength(4);
    const review = await reviewNativeBenchmark(repository, result.evidenceDirectory, result.evidenceDigest);
    expect(review).toMatchObject({ outcome: { status: "passed" }, report: { benchmarkOutcome: { status: "failed" } } });
    const other = join(temporary, "different-revision");
    const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: temporary, timeout: 10_000 });
    await git("clone", "--shared", "--quiet", "--no-checkout", repository, other);
    await git("-C", other, "checkout", "--quiet", "--detach", revision);
    await git("-C", other, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit",
      "--quiet", "--allow-empty", "-m", "new reviewed revision");
    expect((await reviewNativeBenchmark(other, result.evidenceDirectory, result.evidenceDigest)).outcome.status).toBe("blocked");
    expect(review.report).toMatchObject({ provider: "injected", revision });
    const receipt = join(result.evidenceDirectory, "acceptance", `${result.report.attempts[2]!.id}.preview-capability.json`);
    const savedReceipt = await readFile(receipt);
    await rm(receipt);
    expect((await reviewNativeBenchmark(repository, result.evidenceDirectory, result.evidenceDigest)).outcome.status).toBe("blocked");
    await writeFile(receipt, savedReceipt);
    const location = Object.values(result.observations)[0]!.location;
    await writeFile(join(result.evidenceDirectory, location), "{}");
    expect((await reviewNativeBenchmark(repository, result.evidenceDirectory, result.evidenceDigest)).outcome.status).toBe("blocked");
  } finally {
    await server.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 120_000);
