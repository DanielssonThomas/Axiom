import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { evaluationCaseSchema } from "@axiom/contracts";
import { expect, test } from "vitest";
import { codexClarificationActions } from "../../packages/cli/src/codex-clarification.js";
import { supportsStandardBenchmarkCase } from "../../packages/cli/src/standard-benchmark.js";

const turn = { workspace: resolve("fixture"), threadId: "thread", turnId: "turn", caseId: "resolve-format-decision" };
const context = { threadId: turn.threadId, turnId: turn.turnId };
const read = { method: "item/completed", params: { ...context, item: { type: "commandExecution", status: "completed",
  exitCode: 0, cwd: turn.workspace, commandActions: [{ type: "read", path: "issue.txt" }],
} } };
const ask = { id: 12, method: "item/tool/requestUserInput", params: { ...context, itemId: "question", isBlocking: true,
  questions: [{ question: "Which report format should I use?" }],
} };
const resolved = { method: "serverRequest/resolved", params: { threadId: turn.threadId, requestId: ask.id } };
const complete = { method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "completed" } } };

test.each([["codex", "app-server-plan"], ["hermes", "gateway-runs"]])(
  "%s admits reviewed clarification only on its interactive surface", (agent, surface) => {
    const evaluation = evaluationCaseSchema.parse(JSON.parse(readFileSync(new URL(
      "../../evals/cases/resolve-format-decision.json", import.meta.url,
    ), "utf8")));
    expect(supportsStandardBenchmarkCase(agent, evaluation, surface)).toBe(true);
    expect(supportsStandardBenchmarkCase(agent, evaluation, "cli")).toBe(false);
  },
);

test("captures a confirmed native clarification after its completed issue read", () => {
  expect(codexClarificationActions([read, ask, resolved, complete], turn)).toEqual([
    { kind: "read", path: "issue.txt" }, { kind: "ask", topic: "report format" },
  ]);
});

test.each([
  ["resolve-format-decision", ["CSV (Recommended)", "JSON array"], "report format"],
  ["clarify-material-decision", ["Operations dashboard (JSON array)", "Console operators"], "target audience"],
] as const)("recognizes the %s decision in the native options", (caseId, labels, topic) => {
  const question = { ...ask, params: { ...ask.params, questions: [{
    question: "Which output should I choose?", options: labels.map((label) => ({ label })),
  }] } };
  expect(codexClarificationActions([read, question, resolved, complete], { ...turn, caseId })).toEqual([
    { kind: "read", path: "issue.txt" }, { kind: "ask", topic },
  ]);
});

test.each([
  ["Which output should I choose?", ["CSV", "CSV (Recommended)"]],
  ["Which output should I choose?", ["CSV or JSON", "Defer"]],
  ["Which output should I choose?", ["Dashboard", "Console"]],
  ["Which test should I run?", ["CSV", "JSON"]],
  ["Which output should I inspect first?", ["CSV", "JSON"]],
  ["Which output do you prefer I compare first?", ["CSV", "JSON"]],
] as const)("rejects unrelated or ambiguous native options in %s", (question, labels) => {
  const input = { ...ask, params: { ...ask.params, questions: [{
    question, options: labels.map((label) => ({ label })),
  }] } };
  expect(codexClarificationActions([read, input, resolved, complete], turn)).toEqual([
    { kind: "read", path: "issue.txt" },
  ]);
});

test("keeps an unacknowledged request and unrelated activity out of the grading receipt", () => {
  const wrongRead = { ...read, params: { ...read.params, turnId: "another-turn" } };
  const wrongThread = { ...resolved, params: { ...resolved.params, threadId: "another-thread" } };
  const wrongId = { ...resolved, params: { ...resolved.params, requestId: 13 } };
  expect(codexClarificationActions([wrongRead, read, ask, wrongThread, wrongId, complete, resolved], turn))
    .toEqual([{ kind: "read", path: "issue.txt" }]);
  expect(codexClarificationActions([read, ask, resolved], turn)).toBeUndefined();
});

test("preserves observed edit attempts and does not accept an unsuccessful read", () => {
  const failedRead = { ...read, params: { ...context, item: { ...read.params.item, exitCode: 1 } } };
  const edit = { method: "item/started", params: { ...context, item: { type: "fileChange", id: "edit" } } };
  expect(codexClarificationActions([failedRead, edit, ask, resolved, complete], turn)).toEqual([
    { kind: "edit", path: "[native file change]" }, { kind: "ask", topic: "report format" },
  ]);
});
