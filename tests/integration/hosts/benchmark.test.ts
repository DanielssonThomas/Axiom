import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { EvaluationCase } from "@axiom/contracts";
import { buildClaudeBundle, claudeCapabilities, createClaudeBackend, executeClaudeSession, parseClaudeTrace, supportedVersion } from "../../../adapters/claude/src/index.js";
import { gradeCase } from "../../../evals/graders/index.js";
import { loadBundleWorkspace } from "../../../packages/bundles/src/index.js";
import { reviewNativeBenchmark } from "../../../packages/cli/src/benchmark-review.js";
import { defaultBenchmarkLimits, runTrustedClaude } from "../../../packages/cli/src/native-benchmark.js";
import { benchmarkModel } from "../../../packages/cli/src/claude-provider.js";
import { benchmarkRevision, prepareReviewedBaseline } from "../../../packages/cli/src/reviewed-baseline.js";
import { admittedClaudeClarification, claudeClarificationTopic, supportsClaudeClarification } from "../../../packages/cli/src/claude-clarification.js";
import { runStandardArchive } from "../../../packages/cli/src/standard-benchmark.js";
import { runBenchmark } from "../../../packages/benchmark/src/index.js";
import { EvidenceStore, snapshotSource } from "../../../packages/evidence/src/index.js";
import { openLoopback } from "./loopback.js";

const executable = process.env.AXIOM_TEST_CLAUDE_BINARY;

test.runIf(executable && process.platform === "linux")("grades a real Claude CLI pair independently of its scripted reply", async () => {
  const source = process.cwd();
  const graderPath = "evals/graders";
  const casePath = "skills/design/evals/reuse-summary-formatter.json";
  const evaluation = JSON.parse(await readFile(join(source, casePath), "utf8"));
  const grader = await snapshotSource({ root: source, paths: [graderPath, casePath] });
  const host = { agent: "claude", version: supportedVersion, model: "claude-sonnet-4-6", os: "linux", surface: "cli" };
  const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-host-bench-")));
  const server = await openLoopback("claude", host.model);
  try {
    const store = new EvidenceStore(join(root, "evidence"));
    const bundle = await buildClaudeBundle({
      repository: source, destination: join(root, "bundles"), version: "0.1.0", sourceRevision: grader.revision ?? grader.digest,
      policyVersion: "1", selectedProfiles: [], checks: {}, skills: [{ id: "design" }],
    });
    const backend = createClaudeBackend({
      program: executable!, artifacts: store.directory, bundle,
      environment: { ANTHROPIC_BASE_URL: server.endpoint, ANTHROPIC_AUTH_TOKEN: "loopback-only" },
    });
    const result = await runBenchmark({
      fixtureRoot: source, catalog: [evaluation], caseIds: ["reuse-summary-formatter"], host,
      policy: bundle.manifest.policy, capabilities: claudeCapabilities(host), repetitions: 1,
      limits: { timeoutMs: 15_000, maxAttempts: 2, maxConcurrency: 1 }, store,
      // Native transport is real, while the provider script and test environment remain fixtures.
      openRuntime: async (workspace) => ({ kind: "fixture", workspace, backend, close: async () => {} }),
      grader: {
        version: "1", digest: grader.digest,
        grade(definition, observation) {
          return { source: observation.source, assertions: gradeCase(definition, {
            source: observation.source, policy: observation.policy, before: observation.before, after: observation.after,
          }) };
        },
      },
    });
    expect(result.outcome.status).toBe("failed");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.map(({ mode }) => mode).sort()).toEqual(["with_axiom", "without_axiom"]);
    for (const attempt of result.attempts) {
      expect(attempt).toMatchObject({
        runtime: "fixture", outcome: { status: "failed" },
        execution: { host, outcome: { status: "passed" }, usage: { metering: "reported", inputTokens: 9, outputTokens: 3 } },
      });
      const reuse = attempt.assertions.find(({ id }) => id === "reuse-formatter");
      expect(reuse).toMatchObject({ outcome: { status: "failed" }, evidenceId: expect.any(String) });
      const evidence = await store.read("acceptance", reuse!.evidenceId!);
      expect(evidence).toMatchObject({ host, provenance: "observed", outcome: { status: "failed" } });
    }
    expect(server.requests).toHaveLength(2);
    expect(server.requests.filter(({ text }) => text.includes(bundle.manifest.policy.digest))).toHaveLength(1);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);


test.runIf(executable && process.platform === "linux")("captures a native clarification as an ask only through the withheld-answer callback", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-claude-question-")));
  const workspace = join(root, "workspace");
  const home = join(root, "claude");
  const userHome = join(root, "home");
  const issue = join(workspace, "issue.txt");
  const model = "claude-sonnet-4-6";
  const question = "Which target audience should receive the report?";
  const server = await openLoopback("claude", model, ({ toolResults }) => {
    if (toolResults.length === 0) return { name: "Read", arguments: JSON.stringify({ file_path: issue }) };
    if (toolResults.length === 1) return { name: "AskUserQuestion", arguments: JSON.stringify({
      questions: [{ question, header: "Audience", multiSelect: false,
        options: [{ label: "Dashboard", description: "JSON" }, { label: "Console", description: "Text" }] }],
    }) };
  });
  try {
    await Promise.all([mkdir(workspace), mkdir(home), mkdir(userHome)]);
    await writeFile(issue, "Decide the audience before editing.\n");
    const trace = await executeClaudeSession({ program: executable!, workspace, home, userHome,
      environment: { ANTHROPIC_BASE_URL: server.endpoint, ANTHROPIC_AUTH_TOKEN: "loopback-only" },
    }, { model, prompt: "Implement the change described in issue.txt.",
      clarification: (observed: string) => observed === question ? "target audience" : undefined,
    });
    expect(trace.outcome.status).toBe("passed");
    expect(trace.actions).toEqual([{ kind: "read", path: issue }, { kind: "ask", topic: "target audience" }]);
    expect(server.requests).toHaveLength(3);
    expect(server.requests[2]?.toolResults).toEqual(expect.arrayContaining([expect.stringMatching(/No user answer was provided/)]));
    expect(await readFile(issue, "utf8")).toBe("Decide the audience before editing.\n");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);


test("assistant text and mismatched native tool receipts cannot establish clarification", () => {
  const withheld = new Map([["request-1", { toolUseId: "tool-question", topic: "target audience" }]]);
  const format = (events: object[]) => events.map((event) => JSON.stringify(event)).join("\n");
  const text = { type: "assistant", message: { content: [{ type: "text", text: JSON.stringify({
    type: "control_request", request_id: "request-1",
  }) }] } };
  const native = { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-question", name: "AskUserQuestion" }] } };
  const request = { type: "control_request", request_id: "request-1" };
  const receipt = (id: string) => ({ type: "user", message: { content: [{
    type: "tool_result", tool_use_id: id, is_error: true, content: "No user answer was provided.",
  }] }, tool_result_meta: [{ id, permission_decision: { decision: "reject", source: "user_reject" } }] });
  expect(parseClaudeTrace(format([text, native, receipt("tool-question")]), [], undefined, withheld).actions).toEqual([]);
  expect(parseClaudeTrace(format([native, request, receipt("different-tool")]), [], undefined, withheld).actions).toEqual([]);
  expect(parseClaudeTrace(format([native, request, receipt("tool-question")])).actions).toEqual([]);
  expect(parseClaudeTrace(format([native, request, receipt("tool-question")]), [], undefined, withheld).actions)
    .toEqual([{ kind: "ask", topic: "target audience" }]);
});


test.runIf(executable && process.platform === "linux")("grades and replays paired native clarification even when a question follows an edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "axiom-claude-clarification-archive-"));
  const host = { agent: "claude", version: supportedVersion, model: "claude-sonnet-4-6", os: "linux", surface: "cli" };
  const server = await openLoopback("claude", host.model, ({ toolResults }) => {
    if (toolResults.length === 0) return { name: "Read", arguments: '{"file_path":"issue.txt"}' };
    const edited = toolResults[0]?.includes("finance importer");
    if (edited && toolResults.length === 1) return { name: "Write", arguments: '{"file_path":"report.mjs","content":"export const report = [];\\n"}' };
    if (toolResults.length === (edited ? 2 : 1)) return { name: "AskUserQuestion", arguments: JSON.stringify({
      questions: [{ question: edited ? "Which report format should be used?" : "Which target audience should receive the report?",
        header: "Choice", multiSelect: false, options: [{ label: "CSV", description: "Delimited" }, { label: "JSON", description: "Array" }] }],
    }) };
  });
  try {
    const repository = process.cwd();
    const result = await runStandardArchive({ repository, evidenceDirectory: root,
      caseIds: ["clarify-material-decision", "resolve-format-decision"], allowNative: true, timeoutSeconds: 40, repetitions: 1,
    }, host, "injected", async (archive, scratch) => {
      const { directory } = archive.baseline;
      const { catalog, skills } = loadBundleWorkspace(directory);
      const bundle = await buildClaudeBundle({ repository: directory, destination: scratch, version: "0.1.0",
        sourceRevision: archive.baselineRef, policyVersion: catalog.core.version, selectedProfiles: archive.profiles, checks: catalog.checks, skills,
      });
      return { policy: bundle.manifest.policy, bundleDigest: bundle.manifest.digest, backend: createClaudeBackend({
        program: executable!, artifacts: archive.evidenceDirectory, bundle, clarification: admittedClaudeClarification(archive.cases),
        environment: { ANTHROPIC_BASE_URL: server.endpoint, ANTHROPIC_AUTH_TOKEN: "loopback-only" },
      }) };
    });
    if (!("report" in result) || !result.report) throw new Error(result.outcome.status === "passed" ? "Expected a benchmark archive." : result.outcome.reason);
    const report = result.report;
    expect(report).toMatchObject({ mode: "standard", qualification: { status: "blocked" } });
    expect(report.report.attempts.map(({ execution, outcome }) => [execution?.outcome.status, outcome.status])).toEqual([
      ["passed", "passed"], ["passed", "passed"], ["passed", "failed"], ["passed", "failed"],
    ]);
    for (const attempt of report.report.attempts) {
      const receipt = report.observations[attempt.id]!;
      const stored = await readFile(join(report.evidenceDirectory, receipt.location), "utf8");
      const actions = JSON.parse(stored).actions;
      expect(actions).toEqual(attempt.case.id === "clarify-material-decision"
        ? [{ kind: "read", path: "issue.txt" }, { kind: "ask", topic: "target audience" }]
        : [{ kind: "read", path: "issue.txt" }, { kind: "edit", path: "report.mjs" }, { kind: "ask", topic: "report format" }]);
      expect(stored).not.toMatch(/Which (?:report format|target audience)/);
    }
    const review = await reviewNativeBenchmark(repository, report.evidenceDirectory, report.evidenceDigest);
    expect(review).toMatchObject({ outcome: { status: "passed" }, report: { benchmarkOutcome: { status: "failed" }, provider: "injected" } });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);


test("requires a material output choice and a required canonical clarification assertion", () => {
  const audience = claudeClarificationTopic("clarify-material-decision")!;
  const format = claudeClarificationTopic("resolve-format-decision")!;
  expect(audience("Which audience should receive the new summary?")).toBe("target audience");
  expect(audience("Which audience used the previous summary?")).toBeUndefined();
  expect(audience("Which audience should receive the weather alert?")).toBeUndefined();
  expect(format("Which report format should I use?")).toBe("report format");
  expect(format("Which report format did the old importer use?")).toBeUndefined();
  const definition = {
    id: "resolve-format-decision", version: "1", requiredCapabilities: ["action-trace"], assertions: [
      { id: "clarify", description: "Clarify", grader: "trace.clarify-before-edit", required: false },
    ],
    profiles: [], fixture: "unused", prompt: "unused", principleIds: ["AX-01"],
  } satisfies EvaluationCase;
  expect(supportsClaudeClarification(definition)).toBe(false);
  const required = { ...definition, assertions: definition.assertions.map((item) => ({ ...item, required: true })) };
  expect(admittedClaudeClarification([required])(required.id)).toBeTypeOf("function");
  expect(admittedClaudeClarification([{ ...required, version: "2" }])(required.id)).toBeUndefined();
  const changedGrader = { ...required, assertions: [{ ...required.assertions[0]!, grader: "trace.context-discovery" }] };
  expect(admittedClaudeClarification([changedGrader])(required.id)).toBeUndefined();
});


test.runIf(executable && process.platform === "linux" && process.env.AXIOM_TEST_BWRAP === "1")(
  "exercises the strict live batch through the pinned Claude sandbox and independently replays its grades", async () => {
    const repository = process.cwd();
    const revision = await benchmarkRevision(repository);
    const root = await mkdtemp(join(tmpdir(), "axiom-claude-strict-clarification-"));
    const baseline = await prepareReviewedBaseline(repository, root, revision, { baselineRef: revision });
    const runnerUrl = new URL("./ci-runner.mjs", import.meta.url).href;
    const { claudeQualificationCases } = await import(runnerUrl) as { claudeQualificationCases: readonly string[] };
    const toolSurfaces: string[][] = [];
    const server = await openLoopback("claude", benchmarkModel, ({ text, toolResults }) => {
      if (text.includes("Record the disposition of the required browser preview") || text.includes("Implement the command behavior described")) return;
      if (toolResults.length === 0) return { name: "Read", arguments: '{"file_path":"issue.txt"}' };
      if (toolResults.length === 1) return { name: "AskUserQuestion", arguments: JSON.stringify({
        questions: [{ question: toolResults[0]?.includes("target audience undecided")
          ? "Which target audience should receive the summary output?" : "Which report format should I implement?",
          header: "Output", multiSelect: false,
          options: [{ label: "CSV", description: "Delimited" }, { label: "JSON", description: "Array" }] }],
      }) };
    });
    try {
      const result = await runTrustedClaude({ ...defaultBenchmarkLimits, repository, program: executable!, allowPaid: true,
        evidenceDirectory: join(root, "evidence"), caseIds: claudeQualificationCases,
      }, baseline, revision, revision, (body, signal) => {
        const tools = body.tools as { name: string }[];
        toolSurfaces.push(tools.map(({ name }) => name));
       return fetch(server.endpoint + "/v1/messages", { method: "POST", body: JSON.stringify(body), signal });
      });
      expect(result).toMatchObject({ mode: "strict", provider: "injected", metering: { inputTokens: 144, outputTokens: 48 } });
      expect(result.report.attempts.map(({ case: evaluation, execution, outcome }) => [evaluation.id, execution?.outcome.status, outcome.status]))
        .toEqual(claudeQualificationCases.flatMap((id, index) => Array.from({ length: 2 }, () => [id, "passed", index < 2 ? "failed" : "passed"])));
      expect(toolSurfaces.map((tools) => tools.includes("AskUserQuestion"))).toEqual([
        ...Array<boolean>(4).fill(false), ...Array<boolean>(12).fill(true),
      ]);
      for (const attempt of result.report.attempts.slice(2, 4)) {
        expect(attempt.assertions[0]?.outcome).toMatchObject({ status: "failed", reason: expect.stringMatching(/verification record.*missing/i) });
      }
      expect(await reviewNativeBenchmark(repository, result.evidenceDirectory, result.evidenceDigest)).toMatchObject({
        outcome: { status: "passed" }, report: { mode: "strict", provider: "injected", benchmarkOutcome: { status: "failed" } },
      });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000,
);
