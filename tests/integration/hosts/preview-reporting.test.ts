import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { unavailablePreviewCase } from "../../../evals/graders/index.js";
import { reviewNativeBenchmark } from "../../../packages/cli/src/benchmark-review.js";
import { runStandardBenchmark } from "../../../packages/cli/src/standard-benchmark.js";
import { openLoopback } from "./loopback.js";
import { nativeAccountFixture, shellLiteral } from "./native-account.js";

const repository = process.cwd();
const model = "gpt-6-luna";
for (const [agent, binary] of [["codex", process.env.AXIOM_TEST_CODEX_BINARY], ["hermes", process.env.AXIOM_HERMES_CLI]] as const) {
  test.runIf(binary && process.platform === "linux")(`${agent} grades and replays preview reporting from its native boundary`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-native-preview-")));
    const authHome = join(root, "auth");
    const executable = join(root, "fixture-cli");
    const server = await openLoopback("codex", model, ({ text, toolResults }) => {
      const correct = text.includes("# Axiom Core");
      if (agent === "codex" && correct && toolResults.length === 0) {
        const entry = /^- axiom:verify: .*\(file: (r\d+)\/verify\/SKILL\.md\)$/m.exec(text);
        const roots = new Map([...text.matchAll(/^- `(r\d+)` = `(\/[^`\n]+)`$/gm)]
          .map(([, alias, path]) => [alias, path]));
        const skills = entry?.[1] ? roots.get(entry[1]) : undefined;
        if (!skills || !skills.includes("/plugins/cache/")) throw new Error("The native request omitted the installed skill.");
        const skill = join(skills, "verify", "SKILL.md");
        const profile = skills.split("/plugins/cache/")[0]!;
        const command = [
          "test ! -r " + shellLiteral(join(authHome, "auth.json")),
          "test ! -r " + shellLiteral(join(profile, "auth.json")),
          "test ! -w " + shellLiteral(skill),
          'while IFS= read -r line; do printf "%s\\n" "$line"; done < ' + shellLiteral(skill),
        ].join(" && ");
        return { name: "exec_command", arguments: JSON.stringify({ cmd: command }) };
      }
      if (toolResults.length > (agent === "codex" && correct ? 1 : 0)) return;
      const report = JSON.stringify({ criterionId: unavailablePreviewCase.criterion, status: correct ? "blocked" : "passed",
        reason: "The fixture has no running browser preview." });
      return agent === "codex"
        ? { name: "exec_command", arguments: JSON.stringify({ cmd: `printf '%s' ${shellLiteral(report)} > verification.json` }) }
        : { name: "write_file", arguments: JSON.stringify({ path: "verification.json", content: report }) };
    });
    try {
      const { auth, launcher } = nativeAccountFixture(agent, await realpath(binary!), server.endpoint);
      await mkdir(authHome, { mode: 0o700 });
      await writeFile(join(authHome, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
      await writeFile(executable, launcher, { mode: 0o700 });
      const result = await runStandardBenchmark(agent, { repository, evidenceDirectory: join(root, "evidence"), authHome,
        program: executable, model, caseIds: [unavailablePreviewCase.id], allowNative: true,
        repetitions: 1, maxAttempts: 2, timeoutSeconds: 90,
      });
      expect(result.outcome.status, JSON.stringify(result)).toBe("failed");
      if (agent === "codex") {
        expect(server.requests.some(({ toolResults }) => toolResults.some((output) =>
          output.includes("# Verify the outcome") && !output.includes("Permission denied")))).toBe(true);
      }
      if (!("report" in result) || !result.report) throw new Error("Missing preview benchmark archive.");
      const archive = result.report;
      expect(archive.report.attempts).toMatchObject([
        { mode: "with_axiom", execution: { artifacts: expect.arrayContaining([expect.objectContaining({ kind: "native-preview-boundary" })]) },
          assertions: [{ outcome: { status: "passed" } }] },
        { mode: "without_axiom", execution: { artifacts: expect.arrayContaining([expect.objectContaining({ kind: "native-preview-boundary" })]) },
          assertions: [{ outcome: { status: "failed", reason: expect.stringContaining("did not preserve") } }] },
      ]);
      expect((await reviewNativeBenchmark(repository, archive.evidenceDirectory, archive.evidenceDigest)).outcome.status).toBe("passed");
      const receipt = archive.report.attempts[0]!.execution!.artifacts.find(({ kind }) => kind === "native-preview-boundary")!;
      await writeFile(join(archive.evidenceDirectory, receipt.location), "tampered\n");
      expect((await reviewNativeBenchmark(repository, archive.evidenceDirectory, archive.evidenceDigest)).outcome.status).toBe("blocked");
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 100_000);
}
