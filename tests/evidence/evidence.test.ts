import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { evidenceSchema, type HostIdentity, type TaskBrief } from "@axiom/contracts";
import {
  assessEvidence,
  captureCommandEvidence,
  EvidenceStore,
  snapshotSource,
  type CommandCompletion,
  type CommandInvocation,
} from "../../packages/evidence/src/index.js";

const task: TaskBrief = {
  id: "verification",
  parentId: "delivery",
  objective: "Validate the checked source.",
  ownedPaths: ["check.cjs"],
  policy: {
    version: "1",
    digest: `sha256:${"a".repeat(64)}`,
    profiles: [{ id: "ui-atomic", version: "1" }],
  },
  criteria: [{ id: "unit", description: "The check passes.", required: true }],
  requiredCapabilities: [],
  limits: { timeoutMs: 2000, maxAttempts: 3, maxConcurrency: 1 },
};
const host: HostIdentity = { agent: "codex", model: "test-model", os: process.platform, version: "1", surface: "cli" };

let root: string;
let store: EvidenceStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axiom-evidence-"));
  store = new EvidenceStore(join(root, ".axiom", "runs"));
  await writeFile(join(root, "check.cjs"), "process.exit(0);\n");
  await writeFile(join(root, "check-config.json"), '{"enabled":true}\n');
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["add", "--", "check.cjs"], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "Add the check",
  ], { cwd: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(invocation: CommandInvocation, abortOnStart = false): Promise<CommandCompletion> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, { cwd: invocation.cwd, stdio: "ignore" });
    if (abortOnStart) {
      child.once("spawn", () => child.kill("SIGTERM"));
    }
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        resolve({ kind: "unavailable", reason: "executable" });
      } else {
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      if (signal) {
        resolve({ kind: "interrupted", reason: "signal", signal });
      } else if (code !== null) {
        resolve({ kind: "exited", exitCode: code });
      }
    });
  });
}

function capture(id: string, command: CommandInvocation = { executable: process.execPath, args: ["check.cjs"], cwd: root },
  options: { artifacts?: { kind: string; path: string }[]; sensitiveValues?: string[]; abortOnStart?: boolean } = {},
) {
  return captureCommandEvidence(
    { id, task, criterionIds: ["unit"], host, source: { root }, command, store,
      ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
      ...(options.sensitiveValues === undefined ? {} : { sensitiveValues: options.sensitiveValues }),
    },
    (invocation) => run(invocation, options.abortOnStart),
  );
}

function assess(id: string, changes: { expectedHost?: HostIdentity; currentTask?: TaskBrief } = {}) {
  return assessEvidence({
    task: changes.currentTask ?? task, host: changes.expectedHost ?? host, source: { root }, store,
    checks: [{ criterionId: "unit", evidenceIds: [id] }],
  });
}

test("records an actual command with bound provenance and only explicitly selected, redacted metadata", async () => {
  await mkdir(store.directory, { recursive: true });
  await writeFile(join(store.directory, "selected.json"), '{"assertions":1}\n');
  await writeFile(join(store.directory, "unrelated.txt"), "do not collect this");
  const secret = "fixture-token-that-must-not-be-retained";
  const evidence = await capture("actual-run",
    { executable: process.execPath, args: ["check.cjs", `--token=${secret}`], cwd: root },
    { artifacts: [{ kind: "summary", path: "selected.json" }], sensitiveValues: [secret] },
  );
  await store.record("acceptance", evidence);
  expect(evidenceSchema.parse(evidence)).toEqual(evidence);
  expect(evidence).toMatchObject({
    id: "actual-run", taskId: task.id, parentTaskId: task.parentId, criterionIds: ["unit"], policy: task.policy, host,
    provenance: "observed", command: { executable: process.execPath, args: ["check.cjs", "--token=[REDACTED]"], cwd: root, exitCode: 0 },
    outcome: { status: "passed" },
  });
  expect(evidence.source.revision).toMatch(/^[a-f0-9]{40,64}$/);
  expect(Date.parse(evidence.startedAt)).toBeGreaterThan(0);
  expect(evidence.durationMs).toBeGreaterThan(0);
  expect(evidence.artifacts).toEqual([{ kind: "summary", location: "selected.json", digest: expect.stringMatching(/^sha256:/) }]);
  const persisted = await readFile(join(store.directory, "acceptance", "actual-run.json"), "utf8");
  expect(persisted).not.toContain(secret);
  expect(persisted).not.toContain("unrelated");
  expect(Object.keys(JSON.parse(persisted))).not.toContain("env");
  expect((await assess("actual-run")).conforms).toBe(true);
});

test("invalidates passes after tracked and untracked edits with the same Git revision", async () => {
  await store.record("acceptance", await capture("first"));
  expect((await assess("first")).conforms).toBe(true);
  const before = await snapshotSource({ root, excludedPaths: [".axiom/runs"] });
  await writeFile(join(root, "check.cjs"), "process.exitCode = 0;\n");
  const after = await snapshotSource({ root, excludedPaths: [".axiom/runs"] });
  expect(after.revision).toBe(before.revision);
  expect(after.digest).not.toBe(before.digest);
  expect(await assess("first")).toMatchObject({
    conforms: false,
    criteria: [{ results: [{ outcome: { status: "blocked", reason: expect.stringMatching(/source changed/i) } }] }],
  });

  await store.record("acceptance", await capture("second"));
  expect((await assess("second")).conforms).toBe(true);
  await writeFile(join(root, "check-config.json"), '{"enabled":false}\n');
  expect((await assess("second")).conforms).toBe(false);

  await store.record("acceptance", await capture("third"));
  expect((await assess("third")).conforms).toBe(true);
});

test("rejects a nominally successful command that changes the checked source while running", async () => {
  const evidence = await capture("mutating", {
    executable: process.execPath,
    args: ["-e", "require('node:fs').appendFileSync('check.cjs', '// changed')"],
    cwd: root,
  });
  expect(evidence.command?.exitCode).toBe(0);
  expect(evidence.outcome).toEqual({ status: "blocked", reason: expect.stringMatching(/source changed/i) });
});

test("identifies an unavailable executable and an interrupted process", async () => {
  const unavailable = await capture("missing-exe", { executable: join(root, "missing-executable"), args: [], cwd: root });
  expect(unavailable.outcome).toEqual({ status: "blocked", reason: expect.stringMatching(/unavailable/i) });
  expect(unavailable.command?.exitCode).toBeUndefined();
  const interrupted = await capture("interrupted", {
    executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: root,
  }, { abortOnStart: true });
  expect(interrupted.outcome).toEqual({ status: "blocked", reason: expect.stringMatching(/interrupted/i) });
  expect(interrupted.command?.signal).toBe("SIGTERM");
  expect(interrupted.command?.exitCode).toBeUndefined();
  await store.record("acceptance", interrupted);
  expect((await assess("interrupted")).conforms).toBe(false);
});

test("preserves failed RED evidence without using it as acceptance evidence", async () => {
  const red = await capture("fixture-red", { executable: process.execPath, args: ["-e", "process.exitCode = 1"], cwd: root });
  expect(red.outcome.status).toBe("failed");
  await store.record("red", red);
  expect(await store.read("red", "fixture-red")).toEqual(red);
  expect(await store.read("acceptance", "fixture-red")).toBeUndefined();
  expect(await assess("fixture-red")).toMatchObject({
    conforms: false, criteria: [{ results: [{ outcome: { status: "not_run", reason: expect.stringMatching(/missing/i) } }] }],
  });
  await store.record("acceptance", await capture("fixture-green"));
  expect((await assess("fixture-green")).conforms).toBe(true);
  await store.record("acceptance", { ...red, id: "final-failure" });
  expect((await assess("final-failure")).conforms).toBe(false);
  expect(await store.read("red", "fixture-red")).toEqual(red);
});

test("blocks missing and changed referenced artifacts", async () => {
  const selected = [{ kind: "summary", path: "report.json" }];
  const missing = await capture("missing-artifact", undefined, { artifacts: selected });
  expect(missing.outcome).toEqual({ status: "blocked", reason: expect.stringMatching(/missing/i) });

  await mkdir(store.directory, { recursive: true });
  await writeFile(join(store.directory, "report.json"), '{"pass":true}');
  await store.record("acceptance", await capture("with-artifact", undefined, { artifacts: selected }));
  expect((await assess("with-artifact")).conforms).toBe(true);
  await writeFile(join(store.directory, "report.json"), '{"pass":false}');
  expect((await assess("with-artifact")).conforms).toBe(false);
  await rm(join(store.directory, "report.json"));
  expect(await assess("with-artifact")).toMatchObject({
    conforms: false, criteria: [{ results: [{ outcome: { status: "blocked", reason: expect.stringMatching(/artifact.*missing/i) } }] }],
  });
});

test("keeps reported and inapplicable records distinct and rejects wrong host or policy", async () => {
  const observed = await capture("observed");
  await store.record("acceptance", observed);
  await store.record("acceptance", { ...observed, id: "claimed", provenance: "reported",
    outcome: { status: "failed", reason: "The agent said its test failed." } });
  await store.record("acceptance", { ...observed, id: "inapplicable", outcome: { status: "not_applicable", reason: "Excluded case." } });
  expect(await assess("claimed")).toMatchObject({
    conforms: false, criteria: [{ results: [{ outcome: { status: "blocked", reason: expect.stringMatching(/reported/i) } }] }],
  });
  expect((await assess("inapplicable")).conforms).toBe(false);
  expect((await assess("observed", { expectedHost: { ...host, model: "different-model" } })).conforms).toBe(false);
  expect((await assess("observed", { currentTask: { ...task, policy: { ...task.policy, version: "2" } } })).conforms).toBe(false);
});

test("leaves reusable invocation objects untouched across a pass and an interruption", async () => {
  const command = { executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: root };
  await capture("pass-first", command);
  expect(command).toEqual({ executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: root });
  const interrupted = await capture("reuse-invocation", command, { abortOnStart: true });
  expect(interrupted.command?.exitCode).toBeUndefined();
  expect(interrupted.outcome.status).toBe("blocked");
});

test("fingerprints explicitly selected ignored configuration and ignores other generated files", async () => {
  await writeFile(join(root, ".gitignore"), "*.local\n");
  await writeFile(join(root, "config.local"), "config=1");
  await writeFile(join(root, "generated.local"), "generated=1");
  const scope = { root, extraFiles: ["config.local"] };
  const before = await snapshotSource(scope);
  await writeFile(join(root, "generated.local"), "generated=2");
  expect(await snapshotSource(scope)).toEqual(before);
  await writeFile(join(root, "config.local"), "config=2");
  expect((await snapshotSource(scope)).digest).not.toBe(before.digest);
});

test("requires every declared check and keeps optional evidence visible", async () => {
  await store.record("acceptance", await capture("present"));
  const fullTask = { ...task, criteria: [...task.criteria, { id: "extra", description: "Optional item.", required: false }] };
  const outcome = await assessEvidence({
    task: fullTask, source: { root }, store, checks: [{ criterionId: "unit", evidenceIds: ["present", "absent"] }],
  });
  expect(outcome).toMatchObject({
    conforms: false,
    criteria: [
      { criterionId: "unit", required: true, results: [
        { evidenceId: "present", outcome: { status: "passed" } },
        { evidenceId: "absent", outcome: { status: "not_run" } },
      ] },
      { criterionId: "extra", required: false, results: [{ outcome: { status: "not_run" } }] },
    ],
  });
});

test("includes a scoped symlink's consumed target in source freshness", async () => {
  await writeFile(join(root, "linked.config"), "enabled=true");
  await symlink("linked.config", join(root, "config-link"), "file");
  const source = { root, paths: ["config-link"] };
  const before = await snapshotSource(source);
  await writeFile(join(root, "linked.config"), "enabled=false");
  expect((await snapshotSource(source)).digest).not.toBe(before.digest);
});

test("cannot establish evidence when a selected source link escapes the checkout", async () => {
  const otherRoot = await mkdtemp(join(tmpdir(), "axiom-external-"));
  try {
    await writeFile(join(otherRoot, "external.config"), "external=true");
    await symlink(join(otherRoot, "external.config"), join(root, "config-link"), "file");
    await expect(snapshotSource({ root, paths: ["config-link"] })).rejects.toThrow(/outside the checkout/i);
  } finally {
    await rm(otherRoot, { recursive: true, force: true });
  }
});

test("records a thrown executor error as blocked without storing error details", async () => {
  const request = {
    id: "thrown", task, criterionIds: ["unit"], host, source: { root },
    command: { executable: process.execPath, args: ["check.cjs"], cwd: root }, store,
  };
  const error = new Error("internal secret diagnostics");
  const failed = await captureCommandEvidence(request, async () => { throw error; });
  expect(failed.outcome).toEqual({ status: "blocked", reason: expect.stringMatching(/completion/i) });
  expect(failed.command?.exitCode).toBeUndefined();
  expect(JSON.stringify(failed)).not.toContain(error.message);

  const cancelled = await captureCommandEvidence({ ...request, id: "abort-thrown" }, async () => {
    throw new DOMException("secret abort details", "AbortError");
  });
  expect(cancelled.outcome).toEqual({ status: "blocked", reason: expect.stringMatching(/cancellation/i) });
  expect(JSON.stringify(cancelled)).not.toContain("secret abort details");
});
