import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { BackendRequest, BackendResult, EvaluationCase, HostIdentity } from "@axiom/contracts";
import { gradeCase } from "../../evals/graders/index.js";
import { EvidenceStore } from "../../packages/evidence/src/index.js";
import { formatBenchmarkReport, runBenchmark } from "../../packages/benchmark/src/index.js";
import type { BenchmarkOptions, BenchmarkRuntime, OpenBenchmarkRuntime } from "../../packages/benchmark/src/index.js";

const repository = new URL("../../", import.meta.url);
const host: HostIdentity = { agent: "mock", version: "1", model: "fixture-model", os: "linux", surface: "testing" };
const policy = {
  version: "1",
  digest: `sha256:${"a".repeat(64)}`,
  profiles: [{ id: "ui-atomic", version: "1" }],
};
const graderIdentity = { version: "fixture-version", digest: `sha256:${"b".repeat(64)}` };
const shared: EvaluationCase = {
  id: "shared-case", version: "2", profiles: policy.profiles, prompt: "Make the visible source useful.",
  fixture: "evals/cases/fixtures/shared-case", principleIds: ["AX-04"], requiredCapabilities: [],
  assertions: [
    { id: "primary", description: "Required private expectation", grader: "private.primary", required: true },
    { id: "optional", description: "Optional fixture observation", grader: "private.optional", required: false },
  ],
};
const skill: EvaluationCase = {
  ...shared, id: "skill-case", skill: { id: "design", version: "3" },
  fixture: "skills/design/evals/fixtures/skill-case",
};
let root: string;
let store: EvidenceStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axiom-benchmark-test-"));
  store = new EvidenceStore(join(root, "archive"));
  for (const entry of [shared, skill]) {
    const path = join(root, entry.fixture);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "visible.txt"), "pristine");
  }
  await mkdir(join(root, "evals/graders"), { recursive: true });
  await writeFile(join(root, "evals/graders/hidden.txt"), "private expected output");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function execution(request: BackendRequest, overrides: Partial<BackendResult> = {}): BackendResult {
  return {
    requestId: request.id, host, outcome: { status: "passed" }, durationMs: 10,
    artifacts: [], usage: { metering: "unknown", reason: "The fixture does not meter usage." },
    ...overrides,
  };
}

const fake = async (workspace: string): Promise<BenchmarkRuntime> => ({
  kind: "fixture",
  workspace,
  backend: { run: async (request) => execution(request) },
  close: async () => {},
});

function options(overrides: Partial<BenchmarkOptions> = {}): BenchmarkOptions {
  return {
    fixtureRoot: root, catalog: [shared, skill], caseIds: [shared.id], host, policy, store,
    capabilities: [], repetitions: 1, limits: { timeoutMs: 4000, maxConcurrency: 2, maxAttempts: 6 },
    openRuntime: fake,
    grader: { ...graderIdentity, grade: (definition, observation) => ({
      source: observation.source,
      assertions: definition.assertions.map(({ id }) => ({ criterionId: id, outcome: { status: "passed" } })),
    }) },
    ...overrides,
  };
}

test("stages only selected shared and skill-local fixtures and records comparable paired attempts", async () => {
  const requests: BackendRequest[] = [];
  const workspaces: string[] = [];
  const report = await runBenchmark(options({
    caseIds: [skill.id, shared.id], repetitions: 2, limits: { timeoutMs: 5000, maxConcurrency: 2, maxAttempts: 8 },
    openRuntime: async (workspace) => {
      workspaces.push(workspace);
      return {
        ...(await fake(workspace)),
        close: async () => {},
        backend: { run: async (request) => {
          requests.push(request);
          expect(await readdir(workspace)).toEqual(["visible.txt"]);
          expect(await readFile(join(workspace, "visible.txt"), "utf8")).toBe("pristine");
          await writeFile(join(workspace, "visible.txt"), request.mode);
          expect(Object.keys(request).sort()).toEqual(["caseId", "host", "id", "mode", "policy", "prompt", "timeoutMs", "workspace"]);
          expect(JSON.stringify(request)).not.toContain("private");
          return execution(request);
        } },
      };
    },
  }));

  expect(report.outcome.status).toBe("passed");
  expect(formatBenchmarkReport(report, "text")).toMatch(/fixture runtime/i);
  expect(report.attempts).toHaveLength(8);
  expect(new Set(workspaces).size).toBe(8);
  expect(requests.every((request) => request.host.model === host.model && request.policy.digest === policy.digest && request.timeoutMs === 5000)).toBe(true);
  expect(requests.map(({ mode }) => mode).sort()).toEqual([
    "with_axiom", "with_axiom", "with_axiom", "with_axiom",
    "without_axiom", "without_axiom", "without_axiom", "without_axiom",
  ]);
  expect(report.attempts[0]).toMatchObject({
    case: { id: skill.id, version: "2", skill: { id: "design", version: "3" }, profiles: policy.profiles },
    runtime: "fixture",
    execution: { host },
    assertions: [{ id: "primary", grader: "private.primary", outcome: { status: "passed" } }, {
      id: "optional", grader: "private.optional", outcome: { status: "passed" },
    }],
  });
  expect(report.grader).toEqual(graderIdentity);
  const first = report.attempts[0]!;
  const evidence = await store.read("acceptance", first.assertions[0]!.evidenceId!);
  expect(evidence).toMatchObject({ taskId: first.id, host, policy, provenance: "observed", outcome: { status: "passed" } });
  expect(await readFile(join(root, skill.fixture, "visible.txt"), "utf8")).toBe("pristine");
  for (const workspace of workspaces) await expect(readdir(workspace)).rejects.toMatchObject({ code: "ENOENT" });
});

test("uses one initial fixture snapshot even if trusted source inputs change between paired trials", async () => {
  const seen: string[] = [];
  const report = await runBenchmark(options({
    limits: { timeoutMs: 3000, maxConcurrency: 1, maxAttempts: 2 },
    openRuntime: async (workspace) => ({
      ...(await fake(workspace)), backend: { run: async (request) => {
        seen.push(await readFile(join(workspace, "visible.txt"), "utf8"));
        await writeFile(join(root, shared.fixture, "visible.txt"), "later edit");
        return execution(request);
      } },
    }),
  }));
  expect(report.outcome.status).toBe("passed");
  expect(seen).toEqual(["pristine", "pristine"]);
});

test("rejects an oversized report plan before invoking any backend", async () => {
  let used = false;
  await expect(runBenchmark(options({ repetitions: 6000, openRuntime: async (workspace) => {
    used = true;
    return fake(workspace);
  } }))).rejects.toThrow(/plan.*large/i);
  expect(used).toBe(false);
});

test("blocks absent isolation and rejects a private fixture or a symlink before opening runtime", async () => {
  let opened = 0;
  const openRuntime: OpenBenchmarkRuntime = async (workspace) => {
    opened += 1;
    return fake(workspace);
  };
  const unsafe = { ...shared, fixture: "evals/graders" };
  const privateReport = await runBenchmark(options({ catalog: [unsafe], openRuntime }));
  expect(privateReport.attempts[0]?.outcome).toMatchObject({ status: "blocked", reason: expect.stringMatching(/fixture/i) });
  await symlink(join(root, "evals/graders/hidden.txt"), join(root, shared.fixture, "linked.txt"));
  const linkReport = await runBenchmark(options({ openRuntime }));
  expect(linkReport.attempts[0]?.outcome.status).toBe("blocked");
  expect(opened).toBe(0);

  const isolated = options();
  const { openRuntime: _provider, ...noProvider } = isolated;
  const absent = await runBenchmark(noProvider);
  expect(absent.outcome.status).toBe("blocked");
  expect(absent.attempts[0]?.outcome.reason).toMatch(/isolation/i);
});

test("keeps attempted behavior failures and blocked capabilities visible", async () => {
  const unavailable = { ...shared, requiredCapabilities: ["terminal"] };
  const report = await runBenchmark(options({
    catalog: [unavailable, skill], caseIds: [shared.id, skill.id],
    capabilities: [{ id: "terminal", available: false, reason: "unsupported" }],
    openRuntime: async (workspace) => ({
      ...(await fake(workspace)), backend: { run: async (request) => execution(request, {
        outcome: request.mode === "with_axiom" ? { status: "failed", reason: "Observed process failure." } : { status: "passed" },
        usage: { metering: "reported", inputTokens: 12, cost: { amount: 0.03, currency: "USD" } },
      }) },
    }),
  }));
  expect(report.attempts.map((attempt) => attempt.outcome.status)).toEqual(["blocked", "blocked", "failed", "passed"]);
  expect(report.attempts[0]?.outcome.reason).toContain("terminal: unsupported");
  expect(report.outcome.status).toBe("failed");
  expect(formatBenchmarkReport(report, "text")).toContain("USD 0.03");
  expect(formatBenchmarkReport(report, "text")).toContain("Observed process failure.");
  expect(JSON.parse(formatBenchmarkReport(report, "json"))).toEqual(report);
});

test.each(["missing", "stale", "waived"] as const)("prevents required %s grades from making an attempt pass", async (scenario) => {
  const result = await runBenchmark(options({
    grader: { ...graderIdentity, grade: (_definition, observation) => ({
      source: scenario === "stale" ? { digest: `sha256:${"c".repeat(64)}` } : observation.source,
      assertions: [
        { criterionId: "optional", outcome: { status: "passed" } },
        ...scenario === "missing" ? [] : [{
          criterionId: "primary", outcome: scenario === "waived"
            ? { status: "not_applicable", reason: "False waiver." } as const : { status: "passed" } as const,
        }],
      ],
    }) },
  }));
  expect(result.outcome.status).not.toBe("passed");
  const required = result.attempts[0]!.assertions[0]!;
  expect(required.outcome.status).toBe(scenario === "missing" ? "not_run" : "blocked");
  expect(required.outcome.reason).toBeTruthy();
});

test("does not accept backend self-scoring, changed identity, or missing evidence artifacts", async () => {
  for (const bad of [
    (request: BackendRequest) => ({ ...execution(request), score: 1 }),
    (request: BackendRequest) => execution(request, { host: { ...host, model: "different" } }),
    (request: BackendRequest) => execution(request, { artifacts: [{ kind: "trace", location: "missing.json" }] }),
  ]) {
    const result = await runBenchmark(options({ openRuntime: async (workspace) => ({
      ...(await fake(workspace)), backend: { run: async (request) => bad(request) },
    }) }));
    expect(result.attempts[0]?.outcome.status).toBe("blocked");
    expect(result.outcome.status).toBe("blocked");
  }
});

test("shared evidence verification catches an archived trace changed during grading", async () => {
  const result = await runBenchmark(options({
    openRuntime: async (workspace) => ({
      ...(await fake(workspace)), backend: { run: async (request) => {
        const location = `${request.id}.json`;
        await mkdir(store.directory, { recursive: true });
        await writeFile(join(store.directory, location), "{}");
        const artifact = await store.artifact({ kind: "trace", path: location });
        return execution(request, { artifacts: [artifact!] });
      } },
    }),
    grader: { ...graderIdentity, grade: async (definition, observation) => {
      await writeFile(join(store.directory, observation.execution.artifacts[0]!.location), "changed");
      return {
        source: observation.source,
        assertions: definition.assertions.map(({ id }) => ({ criterionId: id, outcome: { status: "passed" } })),
      };
    } },
  }));
  expect(result.outcome.status).toBe("blocked");
  expect(result.attempts[0]?.assertions[0]?.outcome.reason).toMatch(/artifact identity changed/i);
});

test("preserves earlier failures and enforces attempt and concurrency budgets", async () => {
  let current = 0;
  let peak = 0;
  let invocations = 0;
  const result = await runBenchmark(options({
    repetitions: 3, limits: { timeoutMs: 3000, maxConcurrency: 2, maxAttempts: 3 },
    openRuntime: async (workspace) => ({
      ...(await fake(workspace)), backend: { run: async (request) => {
        const invocation = ++invocations;
        current += 1;
        peak = Math.max(peak, current);
        await wait(30);
        current -= 1;
        return execution(request, invocation === 1 ? { outcome: { status: "failed", reason: "First attempt failed." } } : {});
      } },
    }),
  }));
  expect(invocations).toBe(3);
  expect(peak).toBe(2);
  expect(result.attempts.slice(0, 3).map(({ outcome }) => outcome.status).sort()).toEqual(["failed", "passed", "passed"]);
  expect(result.attempts.slice(3).map(({ outcome }) => outcome.status)).toEqual(["not_run", "not_run", "not_run"]);
  expect(result.attempts[5]?.outcome.reason).toMatch(/attempt limit/i);
  expect(result.outcome.status).toBe("failed");
});

test.each(["cancelled", "timed out"] as const)("bounds a hung backend and preserves unstarted trials when %s", async (scenario) => {
  const cancellation = new AbortController();
  let closed = 0;
  let observedAbort = false;
  const report = await runBenchmark(options({
    signal: cancellation.signal, limits: { timeoutMs: 600, maxConcurrency: 1, maxAttempts: 2 },
    openRuntime: async (workspace) => ({
      ...(await fake(workspace)), backend: { run: async (_request, signal) => {
        signal.addEventListener("abort", () => { observedAbort = true; });
        if (scenario === "cancelled") queueMicrotask(() => cancellation.abort());
        return new Promise(() => {});
      } },
      close: async () => { closed += 1; },
    }),
  }));
  expect(closed).toBe(1);
  expect(observedAbort).toBe(true);
  expect(report.attempts.map(({ outcome }) => outcome.status)).toEqual(["blocked", "not_run"]);
  expect(report.attempts[0]?.outcome.reason).toContain(scenario);
  expect(report.outcome.status).toBe("blocked");
  expect(formatBenchmarkReport(report, "text")).toMatch(/metering.*unknown/i);
});

test("uses the existing #7 grader registry through verifier-side injection", async () => {
  const definition = JSON.parse(await readFile(new URL("evals/cases/resolve-format-decision.json", repository), "utf8"));
  const result = await runBenchmark(options({
    fixtureRoot: fileURLToPath(repository), catalog: [definition], caseIds: ["resolve-format-decision"],
    capabilities: [{ id: "action-trace", available: true }],
    grader: { ...graderIdentity, grade: (evaluation, observation) => ({
      source: observation.source,
      assertions: gradeCase(evaluation, { ...observation, actions: [
        { kind: "read", path: "issue.txt" }, { kind: "ask", topic: "report format" },
      ] }),
    }) },
  }));
  expect(result.outcome.status).toBe("passed");
});
