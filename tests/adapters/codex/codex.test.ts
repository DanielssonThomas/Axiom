import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { backendResultSchema, taskBriefSchema, type BackendRequest, type TaskBrief } from "@axiom/contracts";
import {
  assessCodexActivation, buildCodexBundle, codexCapabilities, createCodexBackend,
  parseCodexTrace, transformProfileInstructions,
} from "../../../adapters/codex/src/index.js";
import { runCodex } from "../../../adapters/codex/src/process.js";
import { resolveCodexAccountProgram } from "../../../adapters/codex/src/backend.js";
import { EvidenceStore } from "../../../packages/evidence/src/index.js";

let root: string;
const core = { path: "core/AXIOMS.md", version: "1", text: "# Core\n\n## AX-04 — Verify the requested outcome\n\nUse observed checks.\n" };
const catalog = { core, profiles: [], checks: { "mechanical-check": { kind: "mechanical" as const, corePrincipleIds: ["AX-04"] } } };
const version = "0.172.0-alpha.2";
const host = { agent: "codex", version, model: "fixture-model", os: "linux", surface: "cli" };
const success = { id: "mechanical-check", kind: "mechanical" as const, outcome: { status: "passed" as const } };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axiom-codex-test-"));
  await mkdir(join(root, "source/skills/fixture/evals"), { recursive: true });
  await writeFile(join(root, "source/skills/fixture/SKILL.md"), "---\nname: fixture\ndescription: Verify a fixture.\n---\nVerify it.\n");
  await writeFile(join(root, "source/skills/fixture/evals/private.json"), "{ \"private\": true }");
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function bundle() {
  return buildCodexBundle({
    source: join(root, "source"), destination: join(root, "market"), version: "1.0.0", catalog, profiles: [],
  });
}

test.runIf(process.platform === "linux" && ["x64", "arm64"].includes(process.arch))(
  "resolves the official npm launcher to the executable inside its installed platform package", async () => {
    const packages = join(root, "node_modules", "@openai");
    const shim = join(packages, "codex", "bin", "codex.js");
    const architecture = process.arch === "x64" ? "x86_64" : "aarch64";
    const platformPackage = join(packages, `codex-linux-${process.arch}`);
    const native = join(platformPackage, "vendor", `${architecture}-unknown-linux-musl`, "bin", "codex");
    await mkdir(join(packages, "codex", "bin"), { recursive: true });
    await mkdir(join(native, ".."), { recursive: true });
    await writeFile(join(packages, "codex", "package.json"), '{"name":"@openai/codex"}');
    await writeFile(join(platformPackage, "package.json"), "{}");
    await writeFile(shim, "#!/usr/bin/env node\n", { mode: 0o700 });
    await writeFile(native, "#!/bin/sh\n", { mode: 0o700 });
    await expect(resolveCodexAccountProgram(shim)).resolves.toBe(native);
    await expect(resolveCodexAccountProgram(native)).resolves.toBe(native);
    await rm(native);
    await expect(resolveCodexAccountProgram(shim)).rejects.toThrow(/platform executable/);
  },
);

test("packages canonical skills and resolves policy through the shared contract", async () => {
  const built = await bundle();
  const plugin = join(built.root, "plugins/axiom");
  expect(JSON.parse(await readFile(join(plugin, ".codex-plugin/plugin.json"), "utf8"))).toMatchObject({
    name: "axiom", version: "1.0.0", skills: "./skills/",
  });
  expect(JSON.parse(await readFile(join(built.root, ".agents/plugins/marketplace.json"), "utf8"))).toMatchObject({
    name: "axiom-local", plugins: [{ source: { source: "local", path: "./plugins/axiom" } }],
  });
  expect(await readFile(join(plugin, "skills/fixture/SKILL.md"), "utf8"))
    .toBe(await readFile(join(root, "source/skills/fixture/SKILL.md"), "utf8"));
  await expect(readFile(join(plugin, "skills/fixture/evals/private.json"), "utf8")).rejects.toHaveProperty("code", "ENOENT");
  expect(JSON.parse(await readFile(join(plugin, "axiom-policy.json"), "utf8")).policy)
    .toEqual(built.policy);
  expect(built.instructions).toContain(built.policy.digest);
});

test("updates and removes only the owned profile instruction fragment idempotently", async () => {
  const built = await bundle();
  const original = "# My own profile\nPreserve this byte for byte.\n";
  const first = transformProfileInstructions(original, built.instructions);
  expect(first).toContain(original);
  expect(first).toContain(built.policy.digest);
  expect(transformProfileInstructions(first, built.instructions)).toBe(first);
  const updated = transformProfileInstructions(first + "\nA later user edit.\n", built.instructions.replace("Use observed checks.", "Observe new checks."));
  expect(updated).toContain("Observe new checks.");
  expect(transformProfileInstructions(updated)).toBe(original + "\nA later user edit.\n");
  expect(transformProfileInstructions(original)).toBe(original);
});

test("blocks absent, disabled, unobserved, conflicting, failing, and delegated activation", async () => {
  const built = await bundle();
  const input = { bundle: built, host, catalog, observations: [success], discovered: true, selected: true,
    contexts: [built.instructions], skills: ["axiom:fixture"], observedVersion: version };
  expect(assessCodexActivation(input)).toMatchObject({
    discovery: true, selection: true, loading: true, outcome: { status: "passed" },
  });
  expect(assessCodexActivation({ ...input, discovered: false, selected: false, contexts: [], skills: [] })).toMatchObject({
    discovery: false, selection: false, loading: false, outcome: { status: "blocked" },
  });
  expect(assessCodexActivation({ ...input, selected: false })).toMatchObject({ outcome: { status: "blocked" } });
  expect(assessCodexActivation({ ...input, contexts: [] })).toMatchObject({ outcome: { status: "blocked" } });
  expect(assessCodexActivation({ ...input, observedVersion: "0.0.1" })).toMatchObject({ outcome: { status: "blocked" } });
  expect(assessCodexActivation({ ...input, conflicts: [{ authority: "user", path: "AGENTS.md", reason: "Keep the user's instruction." }] })).toMatchObject({
    outcome: { status: "blocked" }, assessment: { outcome: { status: "blocked" } },
  });
  expect(assessCodexActivation({
    ...input, observations: [{ ...success, outcome: { status: "failed", reason: "Intentional failed shared check." } }],
  })).toMatchObject({ outcome: { status: "failed" } });
  expect(assessCodexActivation({
    ...input, requiredCapabilities: ["delegation"],
  })).toMatchObject({ outcome: { status: "blocked", reason: expect.stringMatching(/delegation/i) } });
  expect(codexCapabilities(host)).toContainEqual({ id: "delegation", available: false, reason: expect.any(String) });
});

test("requires the exact staged brief and native policy in the spawned worker's first request", async () => {
  const built = await bundle();
  const brief: TaskBrief = {
    id: "worker-task", parentId: "parent-task", objective: "Read the fixture within scope.",
    policy: built.policy, ownedPaths: ["fixture.txt"], criteria: [{ id: "scope", description: "Stay within scope.", required: true }],
    requiredCapabilities: [], limits: { timeoutMs: 1000, maxAttempts: 1, maxConcurrency: 1 },
  };
  const message = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  const policy = message(transformProfileInstructions("# AGENTS.md instructions for /fixture\n\n", built.instructions));
  const worker = message(`${brief.objective}\n\nAxiom scoped worker brief:\n${JSON.stringify(taskBriefSchema.parse(brief))}`);
  const trace = [
    { type: "thread.started", thread_id: "native-parent" },
    { type: "item.completed", item: { type: "collab_tool_call", tool: "spawn_agent", status: "completed",
      sender_thread_id: "native-parent", receiver_thread_ids: ["native-worker"] } },
    { type: "turn.completed" },
  ].map((event) => JSON.stringify(event)).join("\n");
  const request = { turnMetadata: JSON.stringify({
    session_id: "native-parent", parent_thread_id: "native-parent", thread_id: "native-worker",
    thread_source: "subagent", subagent_kind: "thread_spawn", history_initialization: "new", request_kind: "turn",
    model: host.model,
  }), body: { model: host.model, input: [policy, worker] } };
  const input = { bundle: built, host, catalog, observations: [success], discovered: true, selected: true,
    contexts: [built.instructions], skills: ["axiom:fixture"], observedVersion: version,
    requiredCapabilities: ["delegation"], delegation: { brief, trace, requests: [request] } };
  expect(assessCodexActivation(input)).toMatchObject({
    outcome: { status: "passed" },
    delegation: { parentThreadId: "native-parent", workerThreadId: "native-worker", outcome: { status: "passed" } },
  });
  const wrongThread = { ...request, turnMetadata: request.turnMetadata.replace("native-worker", "another-worker") };
  expect(assessCodexActivation({ ...input, delegation: { brief, trace, requests: [wrongThread] } }).outcome.status).toBe("blocked");
  const omittedBrief = { ...request, body: { ...request.body, input: [policy, message(brief.objective)] } };
  expect(assessCodexActivation({ ...input, delegation: { brief, trace, requests: [omittedBrief, request] } }).outcome.status).toBe("failed");
  const omittedPolicy = { ...request, body: { ...request.body, input: [worker] } };
  expect(assessCodexActivation({ ...input, delegation: { brief, trace, requests: [omittedPolicy] } }).outcome.status).toBe("failed");
  const spoofedPolicy = { ...request, body: { ...request.body, input: [{
    ...worker, content: [...policy.content, ...worker.content],
  }] } };
  expect(assessCodexActivation({ ...input, delegation: { brief, trace, requests: [spoofedPolicy] } }).outcome.status).toBe("failed");
});

test("normalizes completed native events, rejects absent success and drops model reasoning", () => {
  const trace = [
    { type: "thread.started" },
    { type: "item.completed", item: { type: "reasoning", text: "sensitive reasoning" } },
    { type: "item.completed", item: { type: "file_change", changes: [{ path: "file.txt", kind: "update" }] } },
    { type: "turn.completed", usage: { input_tokens: 41, output_tokens: 9 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  expect(parseCodexTrace(trace)).toMatchObject({
    outcome: { status: "passed" },
    usage: { metering: "reported", inputTokens: 41, outputTokens: 9 },
    actions: [{ kind: "file-change", path: "file.txt", change: "update" }],
  });
  expect(JSON.stringify(parseCodexTrace(trace))).not.toContain("sensitive");
  expect(parseCodexTrace('{"type":"thread.started"}').outcome.status).not.toBe("passed");
});

test("does not present parent CLI counters as aggregate token usage for a delegated attempt", () => {
  const trace = [
    { type: "thread.started", thread_id: "parent" },
    { type: "item.completed", item: { type: "collab_tool_call", tool: "spawn_agent", status: "completed",
      sender_thread_id: "parent", receiver_thread_ids: ["worker"] } },
    { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 6 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  expect(parseCodexTrace(trace)).toMatchObject({
    outcome: { status: "passed" },
    usage: { metering: "unknown", reason: expect.stringMatching(/worker/i) },
  });
});

test("transports literal argv, stdin, and isolated profile roots through a child process", async () => {
  const script = join(root, "codex fixture.cjs");
  await writeFile(script, [
    'let prompt = ""; process.stdin.on("data", (chunk) => { prompt += chunk; });',
    'process.stdin.on("end", () => console.log(JSON.stringify({',
    '  args: process.argv.slice(2), prompt, home: process.env.HOME, codex: process.env.CODEX_HOME,',
    '})));',
  ].join("\n"));
  const profile = { program: process.execPath, workspace: root, home: join(root, "codex"), userHome: join(root, "home") };
  const args = ["exec", "--json", "--model", "literal model & quotes", "-"];
  const result = await runCodex(profile, [script, ...args], { input: "fixture prompt\n" });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ args, prompt: "fixture prompt\n", home: profile.userHome, codex: profile.home });
});

test("executes documented Codex argv on supported Linux and explicitly blocks other platforms", async () => {
  const program = join(root, "codex-fixture");
  await writeFile(program, [
    "#!/usr/bin/env node",
    'const a = process.argv.slice(2);',
    'if (a[0] === "--version") { console.log("codex-cli 0.172.0-alpha.2"); process.exit(); }',
    'const assert = require("node:assert/strict");',
    'assert(a.includes("exec") && a.includes("--json") && a.includes("--ephemeral"));',
    'assert.equal(a.at(-1), "-");',
    'assert(process.env.CODEX_HOME);',
    'let prompt = ""; process.stdin.on("data", (chunk) => { prompt += chunk; });',
    'process.stdin.on("end", () => {',
    ' if (prompt === "wait") { setInterval(() => {}, 1000); return; }',
    ' assert.equal(prompt, "fixture prompt");',
    ' console.log(JSON.stringify({ type: "turn.completed", usage: {input_tokens:1,output_tokens:2} }));',
    '});',
  ].join("\n"));
  await chmod(program, 0o700);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const backend = createCodexBackend({ program, artifacts: join(root, "artifacts") });
  const request: BackendRequest = {
    id: "try-one", caseId: "fixture", prompt: "fixture prompt", workspace, host,
    policy: { version: "1", digest: `sha256:${"0".repeat(64)}`, profiles: [] }, mode: "without_axiom", timeoutMs: 5000,
  };
  const result = backendResultSchema.parse(await backend.run(request, new AbortController().signal));
  if (process.platform !== "linux") {
    expect(result.outcome).toEqual({ status: "blocked", reason: expect.stringMatching(/platform is unsupported/i) });
    expect(result.artifacts).toEqual([]);
    expect(await backend.run(request, AbortSignal.abort())).toMatchObject({ outcome: { status: "not_run" } });
    return;
  }
  expect(result).toMatchObject({ outcome: { status: "passed" }, usage: { metering: "reported", inputTokens: 1 } });
  expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "action-trace" }));
  const trace = result.artifacts.find(({ kind }) => kind === "action-trace")!;
  expect(await new EvidenceStore(join(root, "artifacts")).artifact({ kind: trace.kind, path: trace.location })).toEqual(trace);
  const stopped = await backend.run({ ...request, id: "try-two", prompt: "wait", timeoutMs: 250 }, new AbortController().signal);
  expect(stopped.outcome).toMatchObject({ status: "blocked", reason: expect.stringMatching(/time limit/i) });
  const cancelled = await backend.run({ ...request, id: "try-three" }, AbortSignal.abort());
  expect(cancelled.outcome).toMatchObject({ status: "not_run" });
});

test.runIf(process.platform === "linux")("checks native ChatGPT auth and never archives unvetted command text", async () => {
  const program = join(root, "codex-native-auth");
  const authHome = join(root, "auth-profile");
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  const canary = "sensitive-fixture-canary";
  await Promise.all([mkdir(authHome), mkdir(workspace)]);
  await writeFile(join(authHome, "auth.json"), canary, { mode: 0o600 });
  await writeFile(join(authHome, "AGENTS.md"), "An unrelated profile instruction.");
  await writeFile(program, [
    "#!/usr/bin/env node",
    'const a = process.argv.slice(2), assert = require("node:assert/strict"), fs = require("node:fs");',
    'const p = require("node:path");',
    'if (a[0] === "--version") { console.log("codex-cli 0.172.0-alpha.2"); process.exit(); }',
    'if (a[0] === "login") {',
    ' assert.equal(a[1], "status");',
    ' assert.equal(fs.readlinkSync(p.join(process.env.CODEX_HOME, "auth.json")), ' + JSON.stringify(join(authHome, "auth.json")) + ');',
    ' assert(!fs.existsSync(p.join(process.env.CODEX_HOME, "AGENTS.md")));',
    ' assert.match(fs.readFileSync(p.join(process.env.CODEX_HOME, "config.toml"), "utf8"), /default_permissions = "axiom-benchmark"/);',
    ' console.error(fs.existsSync("allow-native-login") ? "Logged in using ChatGPT" : "API key configured");',
    ' process.exit();',
    '}',
    'if (a[0] === "sandbox") { assert.equal(a[2], "axiom-benchmark"); process.exit(); }',
    'assert(a.includes("exec") && a.includes("--ephemeral") && !a.includes("--sandbox"));',
    'fs.writeFileSync("executed", "yes");',
    'console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: ' + JSON.stringify(canary) + ' } }));',
    'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }));',
  ].join("\n"), { mode: 0o700 });
  const request: BackendRequest = {
    id: "native-auth", caseId: "fixture", prompt: "fixture prompt", workspace, host,
    policy: { version: "1", digest: `sha256:${"0".repeat(64)}`, profiles: [] }, mode: "without_axiom", timeoutMs: 5000,
  };
  const backend = createCodexBackend({ program, artifacts, authHome });
  const run = () => backend.run(request, new AbortController().signal);
  expect(await run()).toMatchObject({ outcome: { status: "blocked", reason: expect.stringMatching(/ChatGPT/) }, artifacts: [] });
  await expect(readFile(join(workspace, "executed"))).rejects.toHaveProperty("code", "ENOENT");
  await writeFile(join(workspace, "allow-native-login"), "");
  const result = await run();
  expect(result).toMatchObject({ outcome: { status: "passed" }, artifacts: [] });
  expect(JSON.stringify(result)).not.toContain(canary);
  await expect(readFile(join(authHome, "auth.json"), "utf8")).resolves.toBe(canary);
});
