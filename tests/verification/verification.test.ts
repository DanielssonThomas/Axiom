import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TaskBrief } from "@axiom/contracts";
import { EvidenceStore } from "../../packages/evidence/src/index.js";
import {
  assessVerification,
  executeVerification,
  planVerification,
  type VerificationRequirement,
} from "../../packages/verification/src/index.js";

let root: string;
let store: EvidenceStore;

const task: TaskBrief = {
  id: "verify-repository",
  objective: "Verify the feature and its running behavior.",
  ownedPaths: ["checks"],
  policy: { version: "1", digest: `sha256:${"b".repeat(64)}`, profiles: [] },
  criteria: [
    { id: "unit", description: "The unit checks pass.", required: true },
    { id: "application", description: "The running application serves healthy responses.", required: true },
  ],
  requiredCapabilities: [],
  limits: { timeoutMs: 10_000, maxAttempts: 1, maxConcurrency: 1 },
};
const automated: VerificationRequirement = {
  id: "unit-check", criterionId: "unit", kind: "automated",
  command: { script: { name: "test" }, docs: [{ path: "README.md", heading: "Automated checks" }] },
};
const runtime: VerificationRequirement = {
  id: "runtime-check", criterionId: "application", kind: "runtime",
  command: { docs: [{ path: "README.md", heading: "Live checks" }] },
};
const live = [{ id: "live-runtime", available: true }] as const;

function verificationTask(criteria: string[] = ["unit"]): TaskBrief {
  return { ...task, criteria: task.criteria.filter((criterion) => criteria.includes(criterion.id)) };
}

async function fixtureScripts(scripts: Record<string, string>) {
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@11.25.0", scripts }));
}

async function fixtureDoc(commands: Record<string, string>) {
  await writeFile(join(root, "README.md"), Object.entries(commands).map(([heading, command]) =>
    [`## ${heading}`, "", "```sh", command, "```", ""].join("\n")).join("\n"));
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "axiom-verification-")));
  store = new EvidenceStore(join(root, ".axiom", "runs"));
  await fixtureScripts({ test: "node check.cjs", build: "node check.cjs", lint: "node check.cjs" });
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await writeFile(join(root, "pnpm-lock.yaml"), [
    "lockfileVersion: '9.0'", "", "settings:", "  autoInstallPeers: true", "  excludeLinksFromLockfile: false",
    "", "importers:", "", "  .: {}", "",
  ].join("\n"));
  await writeFile(join(root, "check.cjs"), "process.exitCode = 0;\n");
  await fixtureDoc({ "Automated checks": "pnpm test" });
  execFileSync("git", ["init", "--quiet", root]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("resolves corroborating repository-native commands and records a real automated check", async () => {
  const plan = await planVerification({ root, task: verificationTask(), requirements: [automated] });
  expect(plan.checks).toMatchObject([{
    id: "unit-check", kind: "automated", invocation: { executable: "pnpm", args: ["run", "test"], cwd: root },
    sources: [{ path: "package.json" }, { path: "pnpm-lock.yaml" }, { path: "README.md", heading: "Automated checks" }],
  }]);
  const result = await executeVerification({ plan, store });
  expect(result.report).toMatchObject({ conforms: true, checks: [{ kind: "automated", outcome: { status: "passed" } }] });
  const [check] = result.report.checks;
  const evidence = await store.read("acceptance", check!.evidenceId!);
  expect(evidence).toMatchObject({
    provenance: "observed", criterionIds: ["unit"], command: { executable: "pnpm", exitCode: 0 },
  });
});

test("reports conflicts and unresolved Markdown commands with source provenance", async () => {
  await fixtureDoc({ "Automated checks": "pnpm run lint", "Live checks": "node check.cjs && echo done" });
  const plan = await planVerification({ root, task, requirements: [automated, runtime] });
  expect(plan.checks).toMatchObject([
    { id: "unit-check", outcome: { status: "blocked", reason: expect.stringMatching(/conflict/i) } },
    { id: "runtime-check", outcome: { status: "blocked", reason: expect.stringMatching(/shell/i) } },
  ]);
  const result = await executeVerification({ plan, store, capabilities: live });
  expect(result.report.conforms).toBe(false);
  expect(result.report.checks.every((check) => check.evidenceId === undefined)).toBe(true);
});

test("uses a documented command against a running application and preserves runtime-only failure", async () => {
  const server = createServer((_request, response) => response.writeHead(503).end("unhealthy"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    await writeFile(join(root, "probe.cjs"),
      "fetch(process.argv[2]).then((response) => { if (!response.ok) process.exitCode = 7; });\n");
    await fixtureDoc({ "Automated checks": "pnpm test", "Live checks": `node probe.cjs http://127.0.0.1:${address.port}/health` });
    const plan = await planVerification({ root, task, requirements: [automated, runtime] });
    const { report } = await executeVerification({ plan, store, capabilities: live });
    expect(report).toMatchObject({
      conforms: false, checks: [
        { kind: "automated", outcome: { status: "passed" } },
        { kind: "runtime", outcome: { status: "failed", reason: expect.stringMatching(/code 7/) } },
      ],
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("blocks unavailable live access and refuses build-only verification of live behavior", async () => {
  await fixtureDoc({ "Automated checks": "pnpm test", "Live checks": "node check.cjs" });
  const plan = await planVerification({ root, task, requirements: [automated, runtime] });
  const { report } = await executeVerification({
    plan, store, capabilities: [{ id: "live-runtime", available: false, reason: "Fixture runtime unavailable" }],
  });
  expect(report).toMatchObject({
    conforms: false, checks: [
      { kind: "automated", outcome: { status: "passed" } },
      { kind: "runtime", outcome: { status: "blocked", reason: expect.stringMatching(/Fixture runtime unavailable/) } },
    ],
  });
  expect(report.checks[1]!.evidenceId).toBeUndefined();

  const invalid = await planVerification({
    root, task: verificationTask(["application"]),
    requirements: [{ ...runtime, command: { script: { name: "build" } } }],
  });
  expect(invalid.checks[0]).toMatchObject({ outcome: { status: "blocked", reason: expect.stringMatching(/automated/i) } });
});

test("reassesses fresh command evidence and blocks it after a source edit", async () => {
  const plan = await planVerification({ root, task: verificationTask(), requirements: [automated] });
  const result = await executeVerification({ plan, store });
  expect(result.report.conforms).toBe(true);
  await writeFile(join(root, "check.cjs"), "process.exitCode = 1;\n");
  expect(await assessVerification(result, store)).toMatchObject({
    conforms: false, checks: [{ outcome: { status: "blocked", reason: expect.stringMatching(/source changed/i) } }],
  });
});

test("does not run a reviewed plan after its authoritative command changes", async () => {
  const plan = await planVerification({ root, task: verificationTask(), requirements: [automated] });
  await fixtureDoc({ "Automated checks": "pnpm run lint" });
  const { report } = await executeVerification({ plan, store });
  expect(report).toMatchObject({
    conforms: false, checks: [{ outcome: { status: "blocked", reason: expect.stringMatching(/plan.*changed/i) } }],
  });
});

test("uses a declared working directory and preserves literal argv without a shell", async () => {
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "check.cjs"), [
    "const assert = require('node:assert/strict');",
    "assert.equal(require('node:path').basename(process.cwd()), 'nested');",
    "assert.equal(process.argv[2], 'literal && touch unexpected');",
  ].join("\n"));
  await fixtureDoc({ "Automated checks": "node check.cjs 'literal && touch unexpected'" });
  const requirement = { ...automated, command: { cwd: "nested", docs: automated.command!.docs! } };
  const plan = await planVerification({ root, task: verificationTask(), requirements: [requirement] });
  const { report } = await executeVerification({ plan, store });
  expect(report).toMatchObject({
    conforms: true, checks: [{ id: "unit-check", outcome: { status: "passed" } }],
  });
  const evidence = await store.read("acceptance", report.checks[0]!.evidenceId!);
  expect(evidence?.command).toMatchObject({ cwd: join(root, "nested"), args: ["check.cjs", "literal && touch unexpected"] });
});

test("reports missing executable, timeout, cancellation, and unmapped required checks separately", async () => {
  await fixtureDoc({
    Missing: "axiom-fixture-executable-that-does-not-exist",
    Timeout: "node -e 'setInterval(() => {}, 1000)'",
  });
  const planned = await planVerification({
    root, task,
    requirements: [
      { ...automated, id: "missing", command: { docs: [{ path: "README.md", heading: "Missing" }] } },
      { ...automated, id: "timeout", timeoutMs: 50, command: { docs: [{ path: "README.md", heading: "Timeout" }] } },
    ],
  });
  const { report } = await executeVerification({ plan: planned, store });
  expect(report).toMatchObject({
    conforms: false,
    checks: [
      { id: "missing", outcome: { status: "blocked", reason: expect.stringMatching(/executable.*unavailable/i) } },
      { id: "timeout", outcome: { status: "blocked", reason: expect.stringMatching(/time limit/i) } },
      { criterionId: "application", outcome: { status: "not_run", reason: expect.any(String) } },
    ],
  });
  const cancelled = await executeVerification({ plan: planned, store, signal: AbortSignal.abort() });
  expect(cancelled.report).toMatchObject({
    conforms: false, checks: [
      { id: "missing", outcome: { status: "not_run", reason: expect.stringMatching(/cancel/i) } },
      { id: "timeout", outcome: { status: "not_run", reason: expect.stringMatching(/cancel/i) } },
      { criterionId: "application", outcome: { status: "not_run", reason: expect.any(String) } },
    ],
  });
});

test("blocks shell string interpreters and structural tools wrapped by package managers", async () => {
  await fixtureDoc({ "Automated checks": "sh -c 'node check.cjs'", "Live checks": "pnpm exec -- tsc --noEmit" });
  const plan = await planVerification({
    root, task, requirements: [{ ...automated, command: { docs: automated.command!.docs! } }, { ...runtime, kind: "visual" }],
  });
  expect(plan.checks).toMatchObject([
    { outcome: { status: "blocked", reason: expect.stringMatching(/shell/i) } },
    { outcome: { status: "blocked", reason: expect.stringMatching(/automated/i) } },
  ]);
});

test("cancels a running command and keeps its interruption as observed evidence", async () => {
  await mkdir(store.directory, { recursive: true });
  const marker = join(store.directory, "started");
  await writeFile(join(root, "running.cjs"), [
    "require('node:fs').writeFileSync(process.argv[2], 'started');",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  await fixtureDoc({ "Automated checks": "node running.cjs '.axiom/runs/started'" });
  const plan = await planVerification({
    root, task: verificationTask(), requirements: [{ ...automated, command: { docs: automated.command!.docs! } }],
  });
  const controller = new AbortController();
  const executing = executeVerification({ plan, store, signal: controller.signal });
  try {
    await vi.waitFor(() => access(marker), { timeout: 2_000 });
  } finally {
    controller.abort();
  }
  const { report } = await executing;
  expect(report).toMatchObject({
    conforms: false, checks: [{ evidenceId: expect.any(String), outcome: { status: "blocked", reason: expect.stringMatching(/cancellation/i) } }],
  });
  const evidence = await store.read("acceptance", report.checks[0]!.evidenceId!);
  expect(evidence?.command?.exitCode).toBeUndefined();
});

test("blocks structural-only native scripts and their aliases when declared as live checks", async () => {
  await fixtureScripts({
    preview: "tsc --noEmit",
    inspect: "pnpm run type-validation",
    "type-validation": "tsc --noEmit",
  });
  await fixtureDoc({ "Live checks": "pnpm run inspect" });
  const plan = await planVerification({
    root, task: verificationTask(["application"]),
    requirements: [
      { ...runtime, id: "manifest-script", command: { script: { name: "preview" } } },
      { ...runtime, id: "documented-script", kind: "visual" },
    ],
  });
  expect(plan.checks).toMatchObject([
    { outcome: { status: "blocked", reason: expect.stringMatching(/automated/i) } },
    { outcome: { status: "blocked", reason: expect.stringMatching(/automated/i) } },
  ]);
});

test("accepts a native live script that probes the running localhost application", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    response.writeHead(request.url === "/health" ? 200 : 404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    await writeFile(join(root, "probe.cjs"),
      "fetch(process.argv[2]).then((response) => { if (!response.ok) process.exitCode = 7; });\n");
    await fixtureScripts({ preview: `node probe.cjs http://127.0.0.1:${address.port}/health` });
    await fixtureDoc({ "Live checks": "pnpm run preview" });
    const plan = await planVerification({
      root, task: verificationTask(["application"]),
      requirements: [{ ...runtime, command: { script: { name: "preview" }, docs: runtime.command!.docs! } }],
    });
    const { report } = await executeVerification({ plan, store, capabilities: live });
    expect(report).toMatchObject({
      conforms: true, checks: [{ kind: "runtime", evidenceId: expect.any(String), outcome: { status: "passed" } }],
    });
    expect(requests).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
