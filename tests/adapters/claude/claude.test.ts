import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
  const active = parseClaudeTrace([
    { type: "system", subtype: "init", claude_code_version: host.version, model: host.model,
      plugins: [{ source: "axiom@axiom-local" }], skills: ["axiom:context"] },
    { type: "system", subtype: "hook_response", exit_code: 0, outcome: "success", hook_event: "SessionStart",
      stdout: JSON.stringify(loaded.output) },
  ].map((event) => JSON.stringify(event)).join("\n")).observation;
  await writeFile(join(built.plugin, "skills/context/SKILL.md"), "An intentionally failing integrity check.");
  const damaged = await runClaudeHook(built.plugin, input);
  expect(damaged).toMatchObject({ exitCode: 2, evidence: { outcome: { status: "failed" } } });
  expect(damaged.output).toBeUndefined();

  expect(assessClaudeActivation(built, host, active)).toMatchObject({ discovery: true, selection: true, loading: true, outcome: { status: "passed" } });
  for (const observation of [
    { ...active, discovered: false, selected: false, skills: [], policySections: [] },
    { ...active, selected: false }, { ...active, policySections: [] }, { ...active, observedVersion: "1.0.0" },
    { ...active, observedModel: "different-model" },
  ]) {
    expect(assessClaudeActivation(built, host, observation).outcome.status).toBe("blocked");
  }
  expect(assessClaudeActivation(built, host, active, ["compaction"]).outcome).toMatchObject({
    status: "blocked", reason: expect.stringMatching(/compaction/i),
  });
});

test("does not count a digest announcement as proof that canonical policy loaded", async () => {
  const built = await bundle();
  const announce = {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `Axiom policy digest: ${built.manifest.policy.digest}\n` },
  };
  const events = [
    { type: "system", subtype: "init", claude_code_version: host.version, model: host.model,
      plugins: [{ source: "axiom@axiom-local" }], skills: ["axiom:context"] },
    { type: "system", subtype: "hook_response", exit_code: 0, outcome: "success", hook_event: "SessionStart",
      stdout: JSON.stringify(announce) },
  ].map((event) => JSON.stringify(event)).join("\n");
  expect(assessClaudeActivation(built, host, parseClaudeTrace(events).observation).outcome.status).toBe("blocked");
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

test("requires complete native policy sections and the expected brief for one observed worker", async () => {
  const built = await buildClaudeBundle({
    repository: process.cwd(), destination: join(root, "profiled"), version: "1.0.0", sourceRevision: "fixture",
    policyVersion: "1", selectedProfiles: ["ui-atomic"], skills: [{ id: "context" }],
    checks: Object.fromEntries(["ui-atomic.composition", "ui-atomic.reuse", "ui-atomic.verification"]
      .map((id) => [id, { kind: "mechanical" }])),
  });
  const brief: TaskBrief = {
    id: "worker", parentId: "parent", objective: "Verify the worker's fixture.",
    ownedPaths: ["tests/fixture"], policy: built.manifest.policy,
    criteria: [{ id: "confirm", description: "Verify this result.", required: true }],
    requiredCapabilities: [], limits: { timeoutMs: 1000, maxAttempts: 1, maxConcurrency: 1 },
  };
  const expected = workerBriefEnvironment(brief).AXIOM_CLAUDE_WORKER_BRIEF;
  const uiPath = "profiles/ui-atomic/PROFILE.md";
  const hookEvent = async (event: "SessionStart" | "SubagentStart", path?: string, agent = "native-worker", worker = expected) => {
    const result = await runClaudeHook(built.plugin, { hook_event_name: event, source: "startup", agent_id: agent }, worker, path);
    expect(result.outcome.status).toBe("passed");
    return { type: "system", subtype: "hook_response", exit_code: 0, outcome: "success", hook_event: event,
      stdout: JSON.stringify(result.output) };
  };
  const parentEvents = [
    { type: "system", subtype: "init", claude_code_version: host.version, model: host.model,
      plugins: [{ source: "axiom@axiom-local" }], skills: ["axiom:context"] },
    await hookEvent("SessionStart"), await hookEvent("SessionStart", uiPath),
  ];
  const core = await hookEvent("SubagentStart");
  const ui = await hookEvent("SubagentStart", uiPath);
  const alternateWorker = await hookEvent("SubagentStart", uiPath, "different-native-worker");
  const unexpectedBrief = await hookEvent("SubagentStart", undefined, "native-worker",
    workerBriefEnvironment({ ...brief, objective: "An unexpected objective." }).AXIOM_CLAUDE_WORKER_BRIEF);
  const wrongPolicy = workerBriefEnvironment({ ...brief, policy: { ...brief.policy, version: "other" } }).AXIOM_CLAUDE_WORKER_BRIEF;
  const wrongPolicyOutput = JSON.parse(core.stdout);
  wrongPolicyOutput.hookSpecificOutput.additionalContext = wrongPolicyOutput.hookSpecificOutput.additionalContext.replace(expected, wrongPolicy);
  const wrongPolicyHook = { ...core, stdout: JSON.stringify(wrongPolicyOutput) };
  const failedWorkerHook = { type: "system", subtype: "hook_response", exit_code: 2, outcome: "error",
    hook_event: "SubagentStart", stderr: "Axiom native hook failed: The installed native bundle failed its integrity check.\n" };
  const assess = (hooks: unknown[], staged: string | null = expected) => {
    const raw = [...parentEvents, ...hooks].map((event) => JSON.stringify(event)).join("\n");
    return assessClaudeActivation(built, host, parseClaudeTrace(raw, [], staged ?? undefined).observation, ["delegation"]);
  };
  expect(assess([core, ui]).outcome.status).toBe("passed");
  expect(assess([core]).outcome.status).toBe("blocked");
  expect(assess([core, alternateWorker]).outcome.status).toBe("blocked");
  expect(assess([unexpectedBrief, ui]).outcome.status).toBe("blocked");
  expect(assess([core, ui], null).outcome.status).toBe("blocked");
  expect(assess([wrongPolicyHook, ui], wrongPolicy).outcome.status).toBe("blocked");
  expect(assess([core, ui, failedWorkerHook]).outcome.status).toBe("failed");
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
  const workspace = join(root, "workspace");
  const archive = join(root, "archive");
  const backend = createClaudeBackend({ program, artifacts: archive });
  const request: BackendRequest = {
    id: "fixture-run", caseId: "fixture", prompt: "fixture prompt", workspace, host, mode: "without_axiom", timeoutMs: 5000,
    policy: { version: "1", digest: `sha256:${"a".repeat(64)}`, profiles: [] },
  };
  if (process.platform !== "linux") {
    expect(await backend.run({ ...request, host: { ...host, os: process.platform } }, new AbortController().signal)).toMatchObject({
      outcome: { status: "blocked", reason: expect.stringMatching(/unsupported/i) }, artifacts: [],
    });
    return;
  }
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
  await mkdir(workspace);
  const result = backendResultSchema.parse(await backend.run(request, new AbortController().signal));
  expect(result).toMatchObject({ outcome: { status: "passed" }, usage: { metering: "reported", inputTokens: 1 } });
  const trace = result.artifacts[0]!;
  expect(await new EvidenceStore(archive).artifact({ kind: trace.kind, path: trace.location })).toEqual(trace);
  const timeout = await backend.run({ ...request, id: "timeout", prompt: "wait", timeoutMs: 150 }, new AbortController().signal);
  expect(timeout.outcome).toMatchObject({ status: "blocked", reason: expect.stringMatching(/time limit/i) });
  expect((await backend.run({ ...request, id: "cancelled" }, AbortSignal.abort())).outcome.status).toBe("not_run");
});

test("stops subprocess work when a launched benchmark reaches its deadline", async () => {
  const program = join(root, "fake-claude");
  const workspace = join(root, "workspace");
  const childPid = join(root, "child-pid");
  const afterDeadline = join(root, "child-finished");
  const backend = createClaudeBackend({ program, artifacts: join(root, "archive") });
  const request: BackendRequest = {
    id: "fixture-deadline", caseId: "fixture", prompt: "fixture prompt", workspace, host, mode: "without_axiom", timeoutMs: 1000,
    policy: { version: "1", digest: `sha256:${"a".repeat(64)}`, profiles: [] },
  };
  if (process.platform !== "linux") {
    expect(await backend.run({ ...request, host: { ...host, os: process.platform } }, new AbortController().signal)).toMatchObject({
      outcome: { status: "blocked", reason: expect.stringMatching(/unsupported/i) },
    });
    return;
  }
  const childScript = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(afterDeadline)}, "finished"), 1300);`;
  await mkdir(workspace);
  await writeFile(program, [
    "#!/usr/bin/env node",
    'if (process.argv[2] === "--version") { console.log("2.1.330 (Claude Code)"); process.exit(); }',
    `const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
    `require("node:fs").writeFileSync(${JSON.stringify(childPid)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"), { mode: 0o700 });
  try {
    expect(await backend.run(request, new AbortController().signal)).toMatchObject({
      outcome: { status: "blocked", reason: expect.stringMatching(/time limit/i) },
    });
    expect(Number(await readFile(childPid, "utf8"))).toBeGreaterThan(0);
    await delay(600);
    await expect(readFile(afterDeadline)).rejects.toHaveProperty("code", "ENOENT");
  } finally {
    const child = await readFile(childPid, "utf8").catch(() => undefined);
    if (child) {
      try { process.kill(Number(child), "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
});
