import { describe, expect, test } from "vitest";
import {
  backendRequestSchema,
  backendResultSchema,
  capabilitySchema,
  evaluationCaseSchema,
  evidenceOutcomeSchema,
  evidenceSchema,
  policyDefinitionSchema,
  principleIdSchema,
  profileDefinitionSchema,
  resultStatusSchema,
  taskBriefSchema,
} from "@axiom/contracts";

const principle = { id: "AX-04", version: "1", source: "core/AXIOMS.md" };
const profile = {
  id: "ui-atomic",
  version: "1",
  extends: [],
  principleIds: [principle.id],
  checks: [{ id: "runtime", required: true, principleIds: [principle.id] }],
};
const policyDefinition = { version: "1", principles: [principle] };
const digest = `sha256:${"a".repeat(64)}`;
const policy = { version: "1", digest, profiles: [{ id: profile.id, version: profile.version }] };
const host = { agent: "codex", version: "1", model: "example-model", os: "linux", surface: "cli" };
const limits = { timeoutMs: 30_000, maxAttempts: 2, maxConcurrency: 1 };
const task = {
  id: "issue-2",
  parentId: "issue-1",
  objective: "Verify the running command",
  ownedPaths: ["packages/cli"],
  policy,
  criteria: [{ id: "run-cli", description: "Check JSON and exit code", required: true }],
  requiredCapabilities: ["process-execution"],
  limits,
};
const evaluationCase = {
  id: "runtime-check",
  version: "1",
  skill: { id: "verify", version: "1" },
  profiles: [{ id: profile.id, version: profile.version }],
  fixture: "fixtures/runtime-check",
  prompt: "Verify the running command.",
  principleIds: [principle.id],
  requiredCapabilities: ["process-execution"],
  assertions: [{ id: "observed-exit", description: "Launch the command", grader: "exit-code", required: true }],
};
const request = {
  id: "attempt-1",
  caseId: evaluationCase.id,
  prompt: evaluationCase.prompt,
  workspace: "/tmp/runtime-check",
  host,
  policy,
  mode: "with_axiom",
  timeoutMs: limits.timeoutMs,
};
const result = {
  requestId: request.id,
  host,
  outcome: { status: "blocked", reason: "The host did not expose execution traces." },
  durationMs: 85,
  artifacts: [],
  usage: { metering: "unknown", reason: "Host did not report usage." },
};
const evidence = {
  id: "execution-1",
  taskId: task.id,
  parentTaskId: task.parentId,
  criterionIds: [task.criteria[0]!.id],
  host,
  policy,
  source: { digest },
  provenance: "observed",
  startedAt: "2026-01-01T10:00:00Z",
  durationMs: 25,
  command: { executable: "node", args: ["cli.js", "check"], cwd: "/tmp/runtime-check", exitCode: 0 },
  artifacts: [{ kind: "stdout", location: "runs/execution-1/stdout.json" }],
  outcome: { status: "passed" },
};

describe("public workspace contracts", () => {
  test.each([
    [policyDefinitionSchema, policyDefinition],
    [profileDefinitionSchema, profile],
    [capabilitySchema, { id: "delegation", available: false, reason: "unsupported" }],
    [taskBriefSchema, task],
    [evaluationCaseSchema, evaluationCase],
    [backendRequestSchema, request],
    [backendResultSchema, result],
    [evidenceSchema, evidence],
  ])("round-trips a valid contract at the package entry point", (schema, value) => {
    const decoded: unknown = JSON.parse(JSON.stringify(value));
    expect(schema.parse(decoded)).toEqual(value);
  });

  test("validates principle and profile identifiers without duplicating the principle registry", () => {
    expect(principleIdSchema.parse("AX-04")).toBe("AX-04");
    expect(principleIdSchema.safeParse("AX-4").success).toBe(false);
    expect(profileDefinitionSchema.safeParse({ ...profile, id: "UI Atomic" }).success).toBe(false);
    expect(policyDefinitionSchema.safeParse({ ...policyDefinition, principles: [] }).success).toBe(false);
  });

  test("accepts exactly the canonical statuses and requires reasons for incomplete outcomes", () => {
    expect(resultStatusSchema.options).toEqual(["passed", "failed", "blocked", "not_run", "not_applicable"]);
    expect(resultStatusSchema.safeParse("unsupported").success).toBe(false);
    for (const status of ["failed", "blocked", "not_run", "not_applicable"]) {
      expect(evidenceOutcomeSchema.safeParse({ status }).success).toBe(false);
      expect(evidenceOutcomeSchema.safeParse({ status, reason: "  " }).success).toBe(false);
      expect(evidenceOutcomeSchema.safeParse({ status, reason: "Recorded explanation" }).success).toBe(true);
    }
    expect(capabilitySchema.safeParse({ id: "delegation", available: false }).success).toBe(false);
    expect(capabilitySchema.safeParse({ id: "delegation", available: true, reason: "unsupported" }).success).toBe(false);
  });

  test("rejects delegated tasks without criteria, scope, or a bound policy identity", () => {
    expect(taskBriefSchema.safeParse({ ...task, criteria: [] }).success).toBe(false);
    expect(taskBriefSchema.safeParse({ ...task, ownedPaths: [] }).success).toBe(false);
    expect(taskBriefSchema.safeParse({ ...task, policy: { ...policy, digest: "unbound" } }).success).toBe(false);
  });

  test("requires observable evaluation assertions without passing grader data to a backend", () => {
    expect(evaluationCaseSchema.safeParse({ ...evaluationCase, assertions: [] }).success).toBe(false);
    expect(backendRequestSchema.safeParse({ ...request, assertions: evaluationCase.assertions }).success).toBe(false);
    expect(backendRequestSchema.safeParse({ ...request, expectedOutput: "private baseline" }).success).toBe(false);
    expect(backendRequestSchema.safeParse({ ...request, timeoutMs: 0 }).success).toBe(false);
    expect(backendResultSchema.safeParse({ ...result, usage: { metering: "unknown" } }).success).toBe(false);
  });

  test("rejects passing evidence from self-report or without source identity", () => {
    expect(evidenceSchema.safeParse({ ...evidence, provenance: "reported" }).success).toBe(false);
    expect(evidenceSchema.safeParse({ ...evidence, source: { revision: "abc123" } }).success).toBe(false);
    expect(evidenceSchema.safeParse({ ...evidence, command: { ...evidence.command, exitCode: 1 } }).success).toBe(false);
  });

  test("allows interrupted evidence without an exit code when there is a reason", () => {
    const { exitCode: _exitCode, ...command } = evidence.command;
    expect(evidenceSchema.safeParse({
      ...evidence,
      command: { ...command, signal: "SIGTERM" },
      outcome: { status: "blocked", reason: "Execution was interrupted." },
    }).success).toBe(true);
    expect(evidenceSchema.safeParse({ ...evidence, command }).success).toBe(false);
  });
});
