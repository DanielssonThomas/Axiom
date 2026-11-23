import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { expect, test } from "vitest";
import { authorizeDispatch, parseLiveInputs, prepareReviewedBaseline, runLiveValidation } from "./live.mjs";
import type { LiveInputs, TrustedLiveRunner } from "./live.mjs";

const repository = new URL("../../", import.meta.url);
const env = {
  AXIOM_HOST: "codex", AXIOM_MODEL: "fixture-model", AXIOM_OS: "linux",
  AXIOM_BASELINE_REF: "a".repeat(40), AXIOM_BASELINE_DIGEST: `sha256:${"b".repeat(64)}`,
  AXIOM_ATTEMPTS: "2", AXIOM_TIMEOUT_MINUTES: "1", AXIOM_TOKEN_BUDGET: "100",
};
const request = () => parseLiveInputs(env);
const supported = { status: "passed" } as const;
const owner = { event: "workflow_dispatch", ref: "refs/heads/main", actor: "owner", triggeringActor: "untrusted-fixture", owner: "owner" };

function workflow(file: string) {
  return parse(readFileSync(new URL(`.github/workflows/${file}`, repository), "utf8"));
}

test("runs locked foundation and fixture checks on all three hosted platforms without credentials", () => {
  const deterministic = workflow("foundation.yml");
  expect(Object.keys(deterministic.on).sort()).toEqual(["pull_request", "push"]);
  expect(deterministic.permissions).toEqual({ contents: "read" });
  expect(JSON.stringify(deterministic)).not.toMatch(/secrets\.|pull_request_target|environment\s*:/);
  const job = deterministic.jobs.platform;
  expect(job.strategy.matrix.os).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);
  expect(job.strategy["fail-fast"]).toBe(false);
  const commands = job.steps.map((step: { run?: string }) => step.run);
  expect(commands).toEqual(expect.arrayContaining([
    "pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm build",
    "npm ci --prefix profiles/angular-nx/evals/fixtures/angular-workspace", "pnpm test",
  ]));
  expect(job.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@")).with["persist-credentials"]).toBe(false);
  expect(deterministic.jobs.deterministic.needs).toBe("platform");
});

test("limits live CI to an explicit owner-run dispatch on main and publishes one curated file", () => {
  const live = workflow("live-validation.yml");
  expect(Object.keys(live.on)).toEqual(["workflow_dispatch"]);
  const job = live.jobs.live;
  expect(job.if).toContain("github.ref == 'refs/heads/main'");
  expect(job.if).toContain("github.triggering_actor == github.repository_owner");
  expect(job.if).toContain("github.actor == github.repository_owner");
  expect(job["timeout-minutes"]).toBe(20);
  expect(live.jobs.required.needs).toBe("live");
  const upload = job.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(upload.with.path).toBe("${{ runner.temp }}/axiom-live-summary.json");
  expect(job.steps.filter((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"))
    .every((step: { with: Record<string, unknown> }) => step.with["persist-credentials"] === false)).toBe(true);
  expect(authorizeDispatch(owner)).toBe(true);
  for (const change of [
    { event: "pull_request" }, { ref: "refs/heads/unreviewed" }, { actor: "contributor" },
    { triggeringActor: "contributor" },
  ]) expect(authorizeDispatch({ ...owner, ...change })).toBe(false);
});

test("requires a complete immutable host selection and bounded numeric limits", () => {
  expect(request()).toMatchObject({ host: "codex", model: "fixture-model", os: "linux", attempts: 2, tokenBudget: 100 });
  for (const invalid of [
    { AXIOM_HOST: "other" }, { AXIOM_MODEL: "x; output" }, { AXIOM_OS: "unknown" },
    { AXIOM_BASELINE_REF: "main" }, { AXIOM_BASELINE_DIGEST: "unknown" },
    { AXIOM_ATTEMPTS: "0" }, { AXIOM_TIMEOUT_MINUTES: "21" }, { AXIOM_TOKEN_BUDGET: "NaN" },
  ]) expect(() => parseLiveInputs({ ...env, ...invalid })).toThrow();
});

test("loads reviewed Git archive bytes and rejects unreviewed refs and digest mismatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "axiom-ci-pin-"));
  try {
    const checkout = join(root, "reviewed");
    await mkdir(checkout);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "ci@example.invalid");
    for (const path of ["core", "evals", "profiles", "skills"]) {
      await mkdir(join(checkout, path));
      await writeFile(join(checkout, path, "asset.txt"), "approved");
    }
    git("add", ".");
    git("commit", "--quiet", "-m", "reviewed");
    const baselineRef = git("rev-parse", "HEAD");
    const archive = execFileSync("git", ["archive", "--format=tar", baselineRef, "--", "core", "evals", "profiles", "skills"], { cwd: checkout });
    const baselineDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
    await writeFile(join(checkout, "evals/asset.txt"), "tampered");
    const prepared = await prepareReviewedBaseline(checkout, root, baselineRef, { ...request(), baselineRef, baselineDigest });
    expect(prepared.digest).toBe(baselineDigest);
    expect(await readFile(join(prepared.directory, "evals/asset.txt"), "utf8")).toBe("approved");
    await expect(prepareReviewedBaseline(checkout, root, baselineRef, { ...request(), baselineRef })).rejects.toThrow(/digest/i);
    await expect(prepareReviewedBaseline(checkout, root, "d".repeat(40), { ...request(), baselineRef, baselineDigest })).rejects.toThrow(/reviewed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const metered = (input: LiveInputs, tokens: number) => ({
  host: input.host, model: input.model, os: input.os, outcome: supported,
  metering: { metering: "reported", inputTokens: tokens, outputTokens: 0 } as const,
  evidenceDigest: `sha256:${"e".repeat(64)}`,
});
const driver = (run: TrustedLiveRunner["run"], readiness: TrustedLiveRunner["readiness"] = async () => "ready") =>
  ({ readiness, run });
const approved = { directory: "/reviewed", digest: env.AXIOM_BASELINE_DIGEST };

test("blocks absent native facilities, missing credentials, host evidence and required waivers", async () => {
  const input = request();
  const cases = [
    undefined,
    driver(async () => metered(input, 10), async () => "credentials-unavailable"),
    driver(async () => ({ ...metered(input, 10), evidenceDigest: undefined })),
    driver(async () => ({ ...metered(input, 10), host: "hermes" })),
    driver(async () => ({ ...metered(input, 10), outcome: { status: "not_applicable", reason: "false waiver" } })),
  ];
  for (const runner of cases) {
    const report = await runLiveValidation(input, approved, runner);
    expect(report.outcome.status).toBe("blocked");
    expect(report.attempts.some((attempt) => attempt.outcome.status === "passed")).toBe(false);
  }
});

test("preserves results, spends a shrinking explicit token budget and stops when it is exhausted", async () => {
  const input = request();
  const allocations: number[] = [];
  const passed = await runLiveValidation(input, approved, driver(async (trial) => {
    allocations.push(trial.tokenLimit);
    return metered(input, 40);
  }));
  expect(allocations).toEqual([100, 60]);
  expect(passed.outcome.status).toBe("passed");
  expect(passed.baselineDigest).toBe(approved.digest);
  const exhausted = await runLiveValidation(input, approved, driver(async () => metered(input, 100)));
  expect(exhausted.attempts.map(({ outcome }) => outcome.status)).toEqual(["passed", "not_run"]);
  expect(exhausted.outcome.status).not.toBe("passed");
  const unmetered = await runLiveValidation(input, approved, driver(async () => ({
    ...metered(input, 0), metering: { metering: "unknown", reason: "No counts" },
  })));
  expect(unmetered.attempts.map(({ outcome }) => outcome.status)).toEqual(["blocked", "not_run"]);
  const overrun = await runLiveValidation(input, approved, driver(async () => metered(input, 110)));
  expect(overrun.attempts[0]?.outcome.status).toBe("failed");
  expect(overrun.attempts[1]?.outcome.status).toBe("not_run");
});

test("retains cancellation and keeps raw runner data and private reasons out of summary output", async () => {
  const cancellation = new AbortController();
  const input = request();
  const cancelled = await runLiveValidation(input, approved, driver(async () => {
    cancellation.abort();
    return new Promise(() => {});
  }), cancellation.signal);
  expect(cancelled.attempts.map(({ outcome }) => outcome.status)).toEqual(["blocked", "not_run"]);
  const failed = await runLiveValidation(input, approved, driver(async () => ({
    ...metered(input, 10), outcome: { status: "failed", reason: "secret session log" }, raw: "private graders",
  })));
  expect(failed.outcome.status).toBe("failed");
  expect(JSON.stringify(failed)).not.toMatch(/secret|private graders|\/reviewed/);
});
