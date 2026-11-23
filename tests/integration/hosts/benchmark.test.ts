import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildClaudeBundle, claudeCapabilities, createClaudeBackend, supportedVersion } from "../../../adapters/claude/src/index.js";
import { gradeCase } from "../../../evals/graders/index.js";
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
      program: executable!, artifacts: store.directory, bundle, maxBudgetUsd: 0.1,
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
