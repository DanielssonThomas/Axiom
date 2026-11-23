import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { backendResultSchema, type BackendRequest } from "@axiom/contracts";
import {
  assessCodexActivation, buildCodexBundle, codexCapabilities, createCodexBackend,
  parseCodexTrace, transformProfileInstructions,
} from "../../../adapters/codex/src/index.js";

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

test("executes documented Codex argv with a staged profile and blocks cancellation", async () => {
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
  expect(result).toMatchObject({ outcome: { status: "passed" }, usage: { metering: "reported", inputTokens: 1 } });
  expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "action-trace" }));
  const stopped = await backend.run({ ...request, id: "try-two", prompt: "wait", timeoutMs: 250 }, new AbortController().signal);
  expect(stopped.outcome).toMatchObject({ status: "blocked", reason: expect.stringMatching(/time limit/i) });
  const cancelled = await backend.run({ ...request, id: "try-three" }, AbortSignal.abort());
  expect(cancelled.outcome).toMatchObject({ status: "not_run" });
});
