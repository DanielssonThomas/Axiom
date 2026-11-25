import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const cli = "packages/cli/dist/index.js";

async function preflight(...args: string[]) {
  const result = await exec(process.execPath, [cli, "benchmark", ...args, "--preflight"], {
    env: { ...process.env, ANTHROPIC_API_KEY: "preflight-credential-canary", OPENAI_API_KEY: "preflight-credential-canary" },
  }).then(({ stdout }) => ({ code: 0, stdout }), (error: { code: number; stdout: string }) => error);
  return { code: result.code, output: JSON.parse(result.stdout) };
}

test.each(["codex", "hermes"])("keeps strict %s qualification unavailable before requesting credentials", async (host) => {
  expect(await preflight(host, "--case", "reuse-summary-formatter")).toMatchObject({
    code: 1, output: { status: "blocked", reason: expect.stringMatching(/independently budgeted.*Claude/i) },
  });
});

test.runIf(process.platform === "linux").each([
  ["codex", "codex-cli 0.172.0-alpha.2", "gpt-5.4"],
  ["hermes", "Hermes Agent v0.23.3 (fixture)", "gpt-5.4"],
])("preflights the %s reuse and preview pairs with no account access", async (host, version, model) => {
  const root = await mkdtemp(join(tmpdir(), "axiom-preflight-"));
  try {
    const program = join(root, host);
    await writeFile(program, `#!/bin/sh
[ -z "$ANTHROPIC_API_KEY$OPENAI_API_KEY$CODEX_HOME$HERMES_HOME" ] || exit 3
[ "$#" -eq 1 ] && [ "$1" = --version ] || exit 4
echo '${version}'
`, { mode: 0o700 });
    const authHome = join(root, "operator-account");
    const runtime = [host, "--mode", "standard", "--auth-home", authHome, "--program", program];
    const pair = [...runtime, "--case", "reuse-summary-formatter"];
    const approved = [...pair, "--max-attempts", "2", "--timeout-seconds", "120"];
    expect(await preflight(...approved)).toMatchObject({ code: 0, output: { status: "passed", report: {
      host: { agent: host, model, os: "linux" }, caseIds: ["reuse-summary-formatter"],
      limits: { plannedAttempts: 2, timeoutSeconds: 120 },
      authorization: "--allow-native", qualification: { status: "blocked" },
    } } });
    expect(await preflight(...runtime, "--case", "report-unavailable-preview", "--max-attempts", "2")).toMatchObject({
      code: 0, output: { status: "passed", report: { caseIds: ["report-unavailable-preview"],
        limits: { plannedAttempts: 2 }, qualification: { status: "blocked" },
      } },
    });
    expect(await preflight(...runtime, "--case", "resolve-format-decision")).toMatchObject({
      code: 1, output: { status: "blocked", reason: expect.stringMatching(/cannot independently evaluate/) },
    });
    expect(await preflight(...pair, "--max-attempts", "1")).toMatchObject({
      code: 1, output: { status: "blocked", reason: expect.stringMatching(/cannot cover the requested pairs/) },
    });
    await writeFile(program, "#!/bin/sh\necho unsupported-version\n");
    expect(await preflight(...approved)).toMatchObject({
      code: 1, output: { status: "blocked", reason: expect.stringMatching(/select the pinned/i) },
    });
    await expect(readFile(join(authHome, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("a preflight rejects execution authorization flags", async () => {
  expect(await preflight("claude", "--allow-paid")).toMatchObject({ code: 2, output: { status: "failed" } });
  expect(await preflight("codex", "--mode", "standard", "--allow-native")).toMatchObject({ code: 2, output: { status: "failed" } });
});

test.runIf(process.platform === "linux" && process.env.AXIOM_TEST_BWRAP === "1" && process.env.AXIOM_TEST_CLAUDE_BINARY)(
  "preflights the four strict Claude pairs with the pinned binary and sandbox", async () => {
    const caseIds = ["reuse-summary-formatter", "report-unavailable-preview", "clarify-material-decision", "resolve-format-decision"];
    const args = ["claude", "--program", process.env.AXIOM_TEST_CLAUDE_BINARY!, "--timeout-seconds", "600", "--token-budget", "1000000"];
    expect(await preflight(...args, ...caseIds.flatMap((item) => ["--case", item]))).toMatchObject({
      code: 0, output: { status: "passed", report: {
        credentials: "ANTHROPIC_API_KEY", authorization: "--allow-paid", caseIds,
        limits: { plannedAttempts: 8, tokenBudget: 1_000_000, maxOutputTokens: 2_048, timeoutSeconds: 600 },
        qualification: { status: "blocked" },
      } },
    });
    expect(await preflight(...args, "--case", "preserve-delegated-requirements")).toMatchObject({
      code: 1, output: { status: "blocked", reason: expect.stringMatching(/cannot independently evaluate/) },
    });
  }, 20_000,
);
