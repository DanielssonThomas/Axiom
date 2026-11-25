import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { reviewNativeBenchmark } from "../../../packages/cli/src/benchmark-review.js";
import { runStandardBenchmark } from "../../../packages/cli/src/standard-benchmark.js";
import { openLoopback } from "./loopback.js";
import { nativeAccountFixture } from "./native-account.js";

const model = "gpt-6-luna";
const repository = process.cwd();

for (const [agent, binary, surface, caseId] of [
  ["codex", process.env.AXIOM_TEST_CODEX_BINARY, "app-server-plan", "resolve-format-decision"],
  ["hermes", process.env.AXIOM_HERMES_CLI, "gateway-runs", "clarify-material-decision"],
] as const) {
  test.runIf(binary && process.platform === "linux")(`${agent} grades and replays signed-in clarification on its native surface`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-account-clarification-")));
    const authHome = join(root, "auth");
    const executable = join(root, "fixture-cli");
    const server = await openLoopback("codex", model, ({ text, toolResults }) => {
      if (!toolResults.length) return agent === "codex"
        ? { name: "exec_command", arguments: JSON.stringify({ cmd: "cat issue.txt" }) }
        : { name: "read_file", arguments: JSON.stringify({ path: "issue.txt" }) };
      if (toolResults.length !== 1 || !text.includes("# Axiom Core")) return;
      if (agent === "codex") return { name: "request_user_input", arguments: JSON.stringify({ questions: [{
        id: "format", header: "Choose output",
        question: "Which output should I implement for the first export? Each importer rejects the other.", options: [
          { label: "CSV", description: "Comma-delimited data" }, { label: "JSON", description: "JSON array" },
        ],
      }] }) };
      return { name: "clarify", arguments: JSON.stringify({ questions: [{
        question: "Which output should I implement for the summary? Each consumer rejects the other.",
        choices: ["Dashboard (Recommended)", "Console"],
      }] }) };
    });
    try {
      const { auth, launcher } = nativeAccountFixture(agent, await realpath(binary!), server.endpoint, "read");
      await mkdir(authHome, { mode: 0o700 });
      await writeFile(join(authHome, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
      await writeFile(executable, launcher, { mode: 0o700 });
      const result = await runStandardBenchmark(agent, { repository, evidenceDirectory: join(root, "evidence"), authHome,
        program: executable, model, caseIds: [caseId], allowNative: true, repetitions: 1, maxAttempts: 2, timeoutSeconds: 120,
      });
      expect(result.outcome.status, JSON.stringify(result)).toBe("failed");
      if (!("report" in result) || !result.report) throw new Error("Missing clarification archive.");
      const archive = result.report;
      expect(archive.report.host).toMatchObject({ agent, model, surface, os: "linux" });
      expect(archive.report.attempts).toMatchObject([
        { mode: "with_axiom", execution: { outcome: { status: "passed" },
          artifacts: expect.arrayContaining([expect.objectContaining({ kind: "native-clarification" })]) },
        assertions: [{ outcome: { status: "passed" } }] },
        { mode: "without_axiom", execution: { outcome: { status: "passed" } },
          assertions: [{ outcome: { status: "failed", reason: expect.stringContaining("focused question") } }] },
      ]);
      expect(server.requests.every(({ model: served }) => served === model)).toBe(true);
      expect(server.requests.some(({ text }) => text.includes("# Axiom Core"))).toBe(true);
      expect(server.requests.some(({ text }) => !text.includes("# Axiom Core"))).toBe(true);
      const tool = agent === "codex" ? "request_user_input" : "clarify";
      const initial = server.requests.filter(({ toolResults }) => toolResults.length === 0);
      expect(initial).toHaveLength(2);
      for (const input of initial) expect(input.tools).toContain(tool);
      for (const input of initial) expect(input.userMessages.join("\n")).toContain(
        `If you need to ask the operator a question, send it through the native ${tool} tool.`,
      );
      expect((await reviewNativeBenchmark(repository, archive.evidenceDirectory, archive.evidenceDigest)).outcome.status).toBe("passed");
      for (const [index, attempt] of archive.report.attempts.entries()) {
        const receipt = attempt.execution!.artifacts.find(({ kind }) => kind === "native-clarification")!;
        expect(JSON.parse(await readFile(join(archive.evidenceDirectory, receipt.location), "utf8"))).toMatchObject({
          blockingControls: index === 0 ? 1 : 0,
          settledBlockingControls: index === 0 ? 1 : 0,
          assistantMessageHasQuestionMark: expect.any(Boolean),
        });
      }
      const receipt = archive.report.attempts[0]!.execution!.artifacts.find(({ kind }) => kind === "native-clarification")!;
      await writeFile(join(archive.evidenceDirectory, receipt.location), "tampered\n");
      expect((await reviewNativeBenchmark(repository, archive.evidenceDirectory, archive.evidenceDigest)).outcome.status).toBe("blocked");
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 135_000);
}
