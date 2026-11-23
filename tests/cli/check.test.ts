import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskBrief } from "@axiom/contracts";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runCheck } from "../../packages/cli/src/check.js";
import { EvidenceStore } from "../../packages/evidence/src/index.js";
import type { VerificationRequirement } from "../../packages/verification/src/index.js";

let temporary: string;
let root: string;
let evidenceDirectory: string;

const task: TaskBrief = {
  id: "check-fixture", objective: "Verify the fixture.", ownedPaths: ["check.cjs"],
  policy: { version: "1", digest: `sha256:${"a".repeat(64)}`, profiles: [] },
  criteria: [{ id: "verified", description: "The fixture check passed.", required: true }],
  requiredCapabilities: [],
  limits: { timeoutMs: 5_000, maxAttempts: 1, maxConcurrency: 1 },
};
const requirement: VerificationRequirement = {
  id: "repo-check", criterionId: "verified", kind: "automated",
  command: { docs: [{ path: "README.md", heading: "Verify" }] },
};
const doc = (heading: string, command: string) => `## ${heading}\n\n\`\`\`sh\n${command}\n\`\`\`\n`;
const request = () => ({ root, evidenceDirectory, task, requirements: [requirement] });

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "axiom-cli-check-"));
  root = join(temporary, "repository");
  evidenceDirectory = join(temporary, "archive");
  await mkdir(root);
  execFileSync("git", ["init", "--quiet", root]);
  await writeFile(join(root, "README.md"), doc("Verify", "node check.cjs"));
  await writeFile(join(root, "check.cjs"), "process.exitCode = 0;\n");
});

afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

test("checks a real documented repository command and archives its observed evidence", async () => {
  const checked = await runCheck(request());
  expect(checked).toMatchObject({
    outcome: { status: "passed" },
    report: { conforms: true, checks: [{ id: "repo-check", outcome: { status: "passed" }, evidenceId: expect.any(String) }] },
  });
  const evidence = await new EvidenceStore(evidenceDirectory).read("acceptance", checked.report!.checks[0]!.evidenceId!);
  expect(evidence).toMatchObject({
    command: { executable: "node", args: ["check.cjs"], exitCode: 0 },
    criterionIds: ["verified"], provenance: "observed", policy: task.policy,
  });
});

test("preserves the failure of a required repository command", async () => {
  await writeFile(join(root, "check.cjs"), "process.exitCode = 7;\n");
  expect(await runCheck(request())).toMatchObject({
    outcome: { status: "failed", reason: expect.stringMatching(/code 7/i) },
    report: { conforms: false, checks: [{ outcome: { status: "failed" } }] },
  });
});

test("withholds success without a request, a required criterion, or a mapped check", async () => {
  expect(await runCheck(undefined)).toMatchObject({ outcome: { status: "not_run" } });
  expect(await runCheck({ ...request(), root: "relative" })).toMatchObject({ outcome: { status: "blocked" } });
  const optional = task.criteria.map((criterion) => ({ ...criterion, required: false }));
  expect(await runCheck({ ...request(), task: { ...task, criteria: optional } }))
    .toMatchObject({ outcome: { status: "blocked" } });
  expect(await runCheck({ ...request(), requirements: [] })).toMatchObject({
    outcome: { status: "not_run" },
    report: { conforms: false, checks: [{ criterionId: "verified", outcome: { status: "not_run" } }] },
  });
});

test("blocks runtime checks and task-required capabilities without positive availability", async () => {
  const runtime = { ...requirement, kind: "runtime" };
  expect(await runCheck({ ...request(), requirements: [runtime] })).toMatchObject({
    outcome: { status: "blocked", reason: expect.stringMatching(/live runtime access/i) },
    report: { conforms: false, checks: [{ kind: "runtime", outcome: { status: "blocked" } }] },
  });
  expect(await runCheck({ ...request(), task: { ...task, requiredCapabilities: ["worker-context"] } })).toMatchObject({
    outcome: { status: "blocked", reason: expect.stringContaining("worker-context") },
  });
});

test("blocks a required check whose evidence becomes stale during later verification", async () => {
  await writeFile(join(root, "README.md"), doc("Verify", "node check.cjs") + "\n" + doc("Modify", "node modify.cjs"));
  await writeFile(join(root, "input.txt"), "before\n");
  await writeFile(join(root, "modify.cjs"), 'require("node:fs").writeFileSync("input.txt", "after\\n");\n');
  expect(await runCheck({
    ...request(),
    task: { ...task, criteria: [...task.criteria, { id: "optional", description: "Check a later step.", required: false }] },
    requirements: [requirement, {
      id: "later-check", criterionId: "optional", kind: "automated",
      command: { docs: [{ path: "README.md", heading: "Modify" }] },
    }],
  })).toMatchObject({
    outcome: { status: "blocked", reason: expect.stringMatching(/source changed/i) },
    report: { conforms: false, checks: [{ id: "repo-check", evidenceId: expect.any(String), outcome: { status: "blocked" } }, {}] },
  });
});
