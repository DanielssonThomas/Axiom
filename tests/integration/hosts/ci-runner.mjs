import { join } from "node:path";
import { benchmarkReadiness, defaultBenchmarkLimits, defaultCase, runTrustedClaude } from "../../../packages/cli/dist/native-benchmark.js";
import { unavailablePreviewCase } from "../../../evals/graders/dist/index.js";
import { anthropicMessages } from "../../../packages/cli/dist/claude-provider.js";

export const claudeQualificationCases = Object.freeze([
  defaultCase, unavailablePreviewCase.id, "clarify-material-decision", "resolve-format-decision",
]);

export default {
  async readiness({ host, model, os }, signal) {
    if (process.env.AXIOM_ALLOW_PAID !== "true") return "authorization-required";
    if (os !== "linux" || !process.env.RUNNER_TEMP) return "runner-unavailable";
    return benchmarkReadiness(host, model, process.env.AXIOM_CLAUDE_PROGRAM, signal);
  },
  async run(trial, signal) {
    if (await this.readiness(trial, signal) !== "ready" || !trial.baselineRef) throw new Error("The trusted runner is unavailable.");
    const result = await runTrustedClaude({
      ...defaultBenchmarkLimits,
      repository: process.cwd(),
      model: trial.model,
      allowPaid: true,
      caseIds: claudeQualificationCases,
      timeoutSeconds: Number(process.env.AXIOM_TIMEOUT_MINUTES) * 60,
      ...(process.env.AXIOM_CLAUDE_PROGRAM ? { program: process.env.AXIOM_CLAUDE_PROGRAM } : {}),
      evidenceDirectory: join(process.env.RUNNER_TEMP, "axiom-evidence"),
    }, trial.baseline, process.env.GITHUB_SHA, trial.baselineRef, anthropicMessages(process.env.ANTHROPIC_API_KEY), signal);
    // Even a passing case set cannot certify the final installed-host lifecycle and all required worker evidence.
    const outcome = result.outcome.status === "passed"
      ? { status: "blocked", reason: "The behavioral benchmark alone does not cover installed-host qualification." }
      : result.outcome;
    return { host: result.report.host.agent, os: result.report.host.os, model: result.report.host.model,
      outcome, metering: result.metering, evidenceDigest: result.evidenceDigest };
  },
};
