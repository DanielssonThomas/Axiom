import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { resultStatusSchema } from "@axiom/contracts";

const executable = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));

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

test.each(["doctor", "check"])("%s reports the operation as unimplemented and exits nonzero", (command) => {
  const { code, output } = run(command);
  expect(code).toBe(1);
  expect(output).toEqual({ command, status: "not_run", reason: expect.stringMatching(/not implemented/i) });
  expect(resultStatusSchema.parse(output.status)).toBe("not_run");
});

test("both benchmark forms return the same result and echo the requested agent", () => {
  const benchmark = run("benchmark", "codex");
  expect(benchmark).toEqual({
    code: 1,
    output: { command: "benchmark", agent: "codex", status: "not_run", reason: expect.stringMatching(/not implemented/i) },
  });
  expect(run("--benchmark", "codex")).toEqual(benchmark);
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
