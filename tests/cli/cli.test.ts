import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { resultStatusSchema } from "@axiom/contracts";

const executable = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));
const temporary: string[] = [];
const digest = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
const host = { agent: "codex", version: "0.172.0-alpha.2", model: "fixture-model", os: "linux", surface: "cli" };

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  const output = JSON.parse(result.stdout);
  return { code: result.status, output };
}

function directory() {
  const root = mkdtempSync(join(tmpdir(), "axiom-cli-"));
  temporary.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each(["doctor", "check"])("%s blocks when no trusted operator request is supplied", (command) => {
  const { code, output } = run(command);
  expect(code).toBe(1);
  expect(output).toEqual({ command, status: "blocked", reason: expect.stringMatching(/request/i) });
  expect(resultStatusSchema.parse(output.status)).toBe("blocked");
});

test("both benchmark forms return the same result and echo the requested agent", () => {
  const benchmark = run("benchmark", "codex");
  expect(benchmark).toEqual({
    code: 1,
    output: { command: "benchmark", agent: "codex", status: "blocked", reason: expect.stringMatching(/budgeted native route/i) },
  });
  expect(run("--benchmark", "codex")).toEqual(benchmark);
});

test("built-in benchmark options preserve explicit authorization and reject invalid numeric arguments", () => {
  expect(run("benchmark", "claude", "--token-budget", "several")).toMatchObject({ code: 2 });
  expect(run("benchmark", "claude", "--token-budget", "300000", "--allow-paid", "--allow-paid")).toMatchObject({ code: 2 });
  const result = run("benchmark", "claude");
  expect(result).toMatchObject({ code: 1, output: { status: "blocked" } });
  if (process.platform === "linux") expect(result.output.reason).toMatch(/--allow-paid/);
});

test("doctor distinguishes fresh native loading from changed installed instructions", () => {
  const root = directory();
  const core = readFileSync(new URL("../../core/AXIOMS.md", import.meta.url), "utf8");
  const selected = { id: "axiom-core", kind: "instruction", path: "AGENTS.md", selected: true, digest: digest(core) };
  const native = { host, path: selected.path, digest: selected.digest, mechanism: "fixture native observation",
    stages: { discoverable: { status: "passed" }, loaded: { status: "passed" } } };
  const path = join(root, "request.mjs");
  const request = { root, catalog: { core: { path: "core/AXIOMS.md", version: "1", text: core }, profiles: [], checks: {} },
    config: { host, profiles: [], sources: [selected], capabilities: [] }, observations: [native] };
  writeFileSync(join(root, selected.path), core);
  writeFileSync(path, "export const doctor = " + JSON.stringify(request));
  expect(run("doctor", "--request", path)).toMatchObject({ code: 0, output: { status: "passed", report: {
    sources: [{ installed: { status: "passed" }, discoverable: { status: "passed" }, loaded: { status: "passed" } }],
  } } });
  writeFileSync(join(root, selected.path), "Changed instructions");
  expect(run("doctor", "--request", path)).toMatchObject({ code: 1, output: { status: "failed", report: {
    sources: [{ installed: { status: "passed" }, loaded: { status: "blocked" } }],
  } } });
});

test("check runs a documented repository command and reports its observed failure", () => {
  const root = directory();
  const evidenceDirectory = directory();
  execFileSync("git", ["init", "--quiet", root]);
  const path = join(root, "request.mjs");
  const task = {
    id: "request-check", objective: "Run the documented command.", ownedPaths: ["check.cjs"],
    policy: { version: "1", digest: digest("policy"), profiles: [] }, requiredCapabilities: [],
    criteria: [{ id: "script", description: "The documented check passes.", required: true }],
    limits: { timeoutMs: 5000, maxAttempts: 1, maxConcurrency: 1 },
  };
  const requirements = [{
    id: "script", criterionId: "script", kind: "automated",
    command: { docs: [{ path: "README.md", heading: "Checks" }] },
  }];
  writeFileSync(path, "export const check = " + JSON.stringify({ root, evidenceDirectory, task, requirements }));
  writeFileSync(join(root, "README.md"), "## Checks\n\n```sh\nnode check.cjs\n```\n");
  writeFileSync(join(root, "check.cjs"), "process.exitCode = 0;\n");
  expect(run("check", "--request", path)).toMatchObject({ code: 0, output: { status: "passed", report: {
    conforms: true, checks: [{ evidenceId: expect.any(String), outcome: { status: "passed" } }],
  } } });

  writeFileSync(join(root, "check.cjs"), "process.exitCode = 7;\n");
  expect(run("check", "--request", path)).toMatchObject({ code: 1, output: { status: "failed", report: {
    conforms: false, checks: [{ evidenceId: expect.any(String), outcome: { status: "failed" } }],
  } } });
});

test("runs both aliases through paired benchmark grading and refuses fixture-only conformance", () => {
  const root = directory();
  const fixture = "evals/cases/fixtures/example";
  mkdirSync(join(root, fixture), { recursive: true });
  writeFileSync(join(root, fixture, "visible.txt"), "original");
  const evaluation = {
    id: "example", version: "1", fixture, profiles: [], principleIds: ["AX-04"], prompt: "Check the fixture.",
    requiredCapabilities: [], assertions: [{ id: "observed", description: "The trusted grader observed the result.",
      grader: "fixture.observed", required: true }],
  };
  const options = {
    host, fixtureRoot: root, evidenceDirectory: join(root, "evidence"), catalog: [evaluation], caseIds: [evaluation.id],
    capabilities: [], repetitions: 1, limits: { timeoutMs: 5000, maxConcurrency: 1, maxAttempts: 2 },
    policy: { version: "1", digest: digest("policy"), profiles: [] },
  };
  const path = join(root, "request.mjs");
  const fixtureModule = `export const benchmark = {
    ...${JSON.stringify(options)},
    grader: { version: "fixture", digest: ${JSON.stringify(digest("grader"))}, grade(evaluation, observation) {
      return { source: observation.source, assertions: [{ criterionId: "observed", outcome: { status: "passed" } }] };
    } },
    async openRuntime(workspace) {
      return { kind: "fixture", workspace, close: async () => {}, backend: { async run(request) {
        return { requestId: request.id, host: request.host, outcome: { status: "passed" }, durationMs: 1,
          artifacts: [], usage: { metering: "reported", inputTokens: 2, outputTokens: 1 } };
      } } };
    }
  };`;
  writeFileSync(path, fixtureModule);
  expect(run("benchmark", "codex", "--request", path)).toMatchObject({
    code: 1, output: { status: "blocked", reason: expect.stringContaining("--allow-paid") },
  });
  function comparable(alias: string) {
    const { output, code } = run(alias, "codex", "--request", path, "--allow-paid");
    return { code, command: output.command, agent: output.agent, status: output.status,
      reason: output.reason, attempts: output.report?.attempts.map((attempt: {
        mode: string; runtime: string; outcome: { status: string };
      }) => ({ mode: attempt.mode, runtime: attempt.runtime, status: attempt.outcome.status })) };
  }
  const result = comparable("benchmark");
  expect(result).toMatchObject({ code: 1, command: "benchmark", agent: "codex", status: "blocked", attempts: [
    { mode: "with_axiom", runtime: "fixture", status: "passed" },
    { mode: "without_axiom", runtime: "fixture", status: "passed" },
  ] });
  expect(comparable("--benchmark")).toEqual(result);
  writeFileSync(path, fixtureModule.replace('kind: "fixture"', 'kind: "isolated"').replace("host: request.host, ", ""));
  expect(comparable("benchmark")).toMatchObject({ code: 1, status: "blocked", attempts: [
    { mode: "with_axiom", runtime: "isolated", status: "blocked" },
    { mode: "without_axiom", runtime: "isolated", status: "blocked" },
  ] });
});

test.each([
  [],
  ["unknown"],
  ["benchmark"],
  ["--benchmark"],
  ["benchmark", "--check"],
  ["benchmark", " "],
  ["benchmark", "codex", "extra"],
  ["doctor", "extra"],
  ["doctor", "--request", "relative.mjs"],
  ["check", "extra"],
])("reports invalid invocation %j as usage failure", (...args) => {
  expect(run(...args)).toEqual({
    code: 2,
    output: {
      status: "failed",
      reason: expect.stringMatching(/usage/i),
    },
  });
});
