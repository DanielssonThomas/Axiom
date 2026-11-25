import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { unavailablePreviewCase } from "../../../evals/graders/index.js";
import { reviewNativeBenchmark } from "../../../packages/cli/src/benchmark-review.js";
import { runStandardBenchmark } from "../../../packages/cli/src/standard-benchmark.js";
import { openLoopback } from "./loopback.js";

const repository = process.cwd();
const model = "gpt-6-luna";
const shellLiteral = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

function nativeAccountFixture(agent: "codex" | "hermes", program: string, endpoint: string) {
  if (agent === "hermes") return {
    auth: { version: 1, credential_pool: { "openai-codex": [{ id: "fixture", label: "Fixture login", auth_type: "oauth",
      priority: 0, source: "manual:device_code", access_token: "preview-fixture-oauth", refresh_token: "preview-fixture-refresh" }] } },
    launcher: `#!/bin/sh\nexport HERMES_CODEX_BASE_URL=${shellLiteral(endpoint + "/backend-api/codex")}\nexec ${shellLiteral(program)} "$@"\n`,
  };
  const jwt = [Buffer.from('{"typ":"JWT","alg":"none"}').toString("base64url"), Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", chatgpt_plan_type: "plus" },
  })).toString("base64url"), "fixture-signature"].join(".");
  const route = `model_providers.fixture={name="Fixture",base_url=${JSON.stringify(endpoint)},wire_api="responses",requires_openai_auth=true,request_max_retries=0,stream_max_retries=0}`;
  const permissions = `permissions.axiom-benchmark.filesystem={":minimal"="read",":workspace_roots"="write",${JSON.stringify(program)}="read"}`;
  return {
    auth: { auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
      tokens: { id_token: jwt, access_token: jwt, refresh_token: "fixture-only", account_id: "fixture-account" } },
    launcher: `#!/bin/sh\nexec ${shellLiteral(program)} -c ${shellLiteral('model_provider="fixture"')} -c ${shellLiteral(route)} -c ${shellLiteral(permissions)} "$@"\n`,
  };
}

for (const [agent, binary] of [["codex", process.env.AXIOM_TEST_CODEX_BINARY], ["hermes", process.env.AXIOM_HERMES_CLI]] as const) {
  test.runIf(binary && process.platform === "linux")(`${agent} grades and replays preview reporting from its native boundary`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-native-preview-")));
    const authHome = join(root, "auth");
    const executable = join(root, "fixture-cli");
    const server = await openLoopback("codex", model, ({ text, toolResults }) => {
      if (toolResults.length) return;
      const correct = text.includes("# Axiom Core");
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
