import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { backendResultSchema, evidenceSchema, type BackendRequest, type TaskBrief } from "@axiom/contracts";
import { EvidenceStore } from "../../../packages/evidence/src/index.js";
import {
  assessClaudeActivation, buildClaudeBundle, createClaudeBackend, parseClaudeTrace, runClaudeHook, workerBriefEnvironment,
} from "../../../adapters/claude/src/index.js";

let root: string;
const host = { agent: "claude", version: "2.1.330", model: "claude-sonnet-4-6", os: "linux", surface: "cli" };

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "axiom-claude-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function bundle() {
  return buildClaudeBundle({
    repository: process.cwd(), destination: join(root, "artifacts"), version: "1.0.0", sourceRevision: "fixture",
    policyVersion: "1", selectedProfiles: [], checks: {}, skills: [{ id: "context" }],
  });
}

test("uses the shared assembler to produce a native Claude marketplace and canonical runtime content", async () => {
  const built = await bundle();
  const plugin = JSON.parse(await readFile(join(built.plugin, ".claude-plugin/plugin.json"), "utf8"));
  expect(plugin).toMatchObject({ name: "axiom", version: "1.0.0", metadata: { policyDigest: built.manifest.policy.digest } });
  expect(JSON.parse(await readFile(join(built.directory, ".claude-plugin/marketplace.json"), "utf8")))
    .toMatchObject({ name: "axiom-local", plugins: [{ source: "./plugins/axiom" }] });
  const hook = JSON.parse(await readFile(join(built.plugin, "hooks/hooks.json"), "utf8"));
  expect(Object.keys(hook.hooks)).toEqual(["SessionStart", "SubagentStart"]);
  expect(await readFile(join(built.plugin, "skills/context/SKILL.md"), "utf8"))
    .toBe(await readFile("skills/context/SKILL.md", "utf8"));
  await expect(readFile(join(built.plugin, "skills/context/evals/clarify-material-decision.json"))).rejects.toHaveProperty("code", "ENOENT");
});

test("uses shared observed evidence, fails on mutated native payload, and reports missing activation", async () => {
  const built = await bundle();
  const input = { hook_event_name: "SessionStart", source: "startup", session_id: "native-session" };
  const loaded = await runClaudeHook(built.plugin, input);
  expect(loaded.exitCode).toBe(0);
  expect(evidenceSchema.parse(loaded.evidence)).toMatchObject({
    policy: built.manifest.policy, provenance: "observed", outcome: { status: "passed" },
  });
  expect(loaded.output?.hookSpecificOutput.additionalContext).toContain(built.manifest.policy.digest);
  await writeFile(join(built.plugin, "skills/context/SKILL.md"), "An intentionally failing integrity check.");
  const damaged = await runClaudeHook(built.plugin, input);
  expect(damaged).toMatchObject({ exitCode: 2, evidence: { outcome: { status: "failed" } } });
  expect(damaged.output).toBeUndefined();

  const active = { discovered: true, selected: true, observedVersion: host.version,
    skills: ["axiom:context"], policyDigests: [built.manifest.policy.digest] };
  expect(assessClaudeActivation(built, host, active)).toMatchObject({ discovery: true, selection: true, loading: true, outcome: { status: "passed" } });
  for (const observation of [
    { ...active, discovered: false, selected: false, skills: [], policyDigests: [] },
    { ...active, selected: false }, { ...active, policyDigests: [] }, { ...active, observedVersion: "1.0.0" },
  ]) {
    expect(assessClaudeActivation(built, host, observation).outcome.status).toBe("blocked");
  }
  expect(assessClaudeActivation(built, host, active, ["compaction"]).outcome).toMatchObject({
    status: "blocked", reason: expect.stringMatching(/compaction/i),
  });
});

test("carries an explicitly staged shared brief into a native SubagentStart event and blocks lost context", async () => {
  const built = await bundle();
  const brief: TaskBrief = {
    id: "worker", parentId: "parent", objective: "Verify the worker's fixture.",
    ownedPaths: ["tests/fixture"], policy: built.manifest.policy,
    criteria: [{ id: "confirm", description: "Verify this result.", required: true }],
    requiredCapabilities: [], limits: { timeoutMs: 1000, maxAttempts: 1, maxConcurrency: 1 },
  };
  const event = { hook_event_name: "SubagentStart", agent_id: "agent-native-1", agent_type: "general-purpose" };
  const env = workerBriefEnvironment(brief);
  const delegated = await runClaudeHook(built.plugin, event, env.AXIOM_CLAUDE_WORKER_BRIEF);
  expect(delegated).toMatchObject({ exitCode: 0, evidence: { taskId: "worker", parentTaskId: "parent", outcome: { status: "passed" } } });
  expect(delegated.output?.hookSpecificOutput.additionalContext).toContain(JSON.stringify(brief));
  const missing = await runClaudeHook(built.plugin, event);
  expect(missing).toMatchObject({ exitCode: 2, evidence: { outcome: { status: "blocked", reason: expect.stringMatching(/brief/i) } } });
  expect(missing.output).toBeUndefined();
});

test("normalizes host events and token usage while excluding message content", () => {
  const events = [
    { type: "system", subtype: "init", claude_code_version: host.version, plugins: [{ name: "axiom", source: "axiom@axiom-local" }], skills: ["axiom:context"] },
    { type: "assistant", message: { content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "tool_use", id: "tool_read", name: "Read", input: { file_path: "fixture.txt" } },
      { type: "tool_use", id: "tool_pending", name: "Edit", input: { file_path: "unexecuted.txt" } },
    ] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool_read", content: "observed fixture" }] } },
    { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.001 },
  ].map((event) => JSON.stringify(event)).join("\n");
  const parsed = parseClaudeTrace(events);
  expect(parsed).toMatchObject({
    outcome: { status: "passed" }, usage: { metering: "reported", inputTokens: 10, outputTokens: 3 },
    actions: [{ kind: "read", path: "fixture.txt" }],
  });
  expect(JSON.stringify(parsed)).not.toContain("private reasoning");
  expect(parsed.actions).toEqual([{ kind: "read", path: "fixture.txt" }]);
  expect(parseClaudeTrace('{"type":"system","subtype":"init"}').outcome.status).not.toBe("passed");
});

test("launches the native bounded benchmark command, resolves traces in the shared archive, and handles timeout", async () => {
  const program = join(root, "fake-claude");
  await writeFile(program, [
    "#!/usr/bin/env node",
    'if (process.argv[2] === "--version") { console.log("2.1.330 (Claude Code)"); process.exit(); }',
    'const assert = require("node:assert/strict");',
    'assert(process.argv.includes("-p") && process.argv.includes("stream-json") && process.argv.includes("--no-session-persistence"));',
    'assert(process.env.CLAUDE_CONFIG_DIR);',
    'let prompt = ""; process.stdin.on("data", (value) => { prompt += value; });',
    'process.stdin.on("end", () => {',
    ' if (prompt === "wait") { setInterval(() => {}, 1000); return; }',
    ' assert.equal(prompt, "fixture prompt");',
    ' console.log(JSON.stringify({ type: "system", subtype: "init", claude_code_version: "2.1.330", model: "claude-sonnet-4-6" }));',
    ' console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: {input_tokens:1,output_tokens:2} }));',
    '});',
  ].join("\n"));
  await chmod(program, 0o700);
  const workspace = join(root, "workspace");
  const archive = join(root, "archive");
  await mkdir(workspace);
  const backend = createClaudeBackend({ program, artifacts: archive, maxBudgetUsd: 0.1 });
  const request: BackendRequest = {
    id: "fixture-run", caseId: "fixture", prompt: "fixture prompt", workspace, host, mode: "without_axiom", timeoutMs: 5000,
    policy: { version: "1", digest: `sha256:${"a".repeat(64)}`, profiles: [] },
  };
  const result = backendResultSchema.parse(await backend.run(request, new AbortController().signal));
  expect(result).toMatchObject({ outcome: { status: "passed" }, usage: { metering: "reported", inputTokens: 1 } });
  const trace = result.artifacts[0]!;
  expect(await new EvidenceStore(archive).artifact({ kind: trace.kind, path: trace.location })).toEqual(trace);
  const timeout = await backend.run({ ...request, id: "timeout", prompt: "wait", timeoutMs: 150 }, new AbortController().signal);
  expect(timeout.outcome).toMatchObject({ status: "blocked", reason: expect.stringMatching(/time limit/i) });
  expect((await backend.run({ ...request, id: "cancelled" }, AbortSignal.abort())).outcome.status).toBe("not_run");
});
