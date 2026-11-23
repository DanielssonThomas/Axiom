import { runClaudeHook, workerBriefKey } from "./runtime.js";

const root = process.env.CLAUDE_PLUGIN_ROOT;
try {
  if (!root) throw new Error("Missing native plugin root.");
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const part of process.stdin) {
    input += part;
    if (input.length > 1_000_000) throw new Error("Oversized native hook input.");
  }
  const result = await runClaudeHook(root, JSON.parse(input), process.env[workerBriefKey], process.argv[2]);
  if (result.output) process.stdout.write(JSON.stringify(result.output) + "\n");
  if (result.outcome.status !== "passed") {
    process.stderr.write(`Axiom native hook ${result.outcome.status}: ${result.outcome.reason}\n`);
  }
  process.exitCode = result.exitCode;
} catch {
  process.stderr.write("Axiom could not validate the Claude lifecycle hook input.\n");
  process.exitCode = 2;
}
