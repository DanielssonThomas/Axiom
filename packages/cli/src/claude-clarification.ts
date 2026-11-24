import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BackendResult, EvaluationCase } from "@axiom/contracts";
import type { EvidenceStore } from "@axiom/evidence";
import type { GradingAction } from "@axiom/graders";
import { sha256 } from "./reviewed-baseline.js";

const topics = new Map([
  ["clarify-material-decision", { topic: "target audience", subject: /\baudiences?\b|(?=.*\bdashboard\b)(?=.*\bconsole\b)/i }],
  ["resolve-format-decision", { topic: "report format", subject: /\bformat\b/i }],
]);

export function supportsClaudeClarification(item: EvaluationCase): boolean {
  const required = item.assertions.filter((assertion) => assertion.required);
  return item.version === "1" && topics.has(item.id) && item.requiredCapabilities.length === 1
    && item.requiredCapabilities[0] === "action-trace" && required.length > 0
    && required.every(({ grader }) => grader === "trace.clarify-before-edit");
}

export function claudeClarificationTopic(caseId: string) {
  const rule = topics.get(caseId);
  if (rule === undefined) return;
  return (question: string) => {
    const text = question.trim();
    const asksForChoice = /^(?:(?:could|can|would) you (?:clarify|confirm|tell me) )?(?:which|what|who)\b/i.test(text)
      || /^should\b.*\bor\b/i.test(text);
    const appliesToOutput = /\b(?:report|summary|output|export)\b/i.test(text);
    const requestsDecision = /\b(?:should|choose|preferred|intended|target|do you (?:want|prefer))\b/i.test(text);
    return text.length <= 512 && text.endsWith("?") && asksForChoice && appliesToOutput && requestsDecision
      && rule.subject.test(text) ? rule.topic : undefined;
  };
}

export async function readClaudeClarification(store: EvidenceStore, execution: BackendResult, workspace: string,
  evaluation: EvaluationCase): Promise<GradingAction[] | undefined> {
  if (!supportsClaudeClarification(evaluation)) return;
  const trace = execution.artifacts.find(({ kind }) => kind === "action-trace");
  if (!trace?.digest || !(await store.artifact({ kind: "action-trace", path: trace.location }))) return;
  const bytes = await readFile(join(store.directory, trace.location), "utf8");
  if (sha256(bytes) !== trace.digest) return;
  const value = JSON.parse(bytes) as { actions?: unknown };
  if (!Array.isArray(value.actions)) return;
  const topic = topics.get(evaluation.id)?.topic;
  const actions: GradingAction[] = [];
  for (const item of value.actions) {
    if (!item || typeof item !== "object") return;
    const action = item as { kind?: unknown; path?: unknown; topic?: unknown };
    if (action.kind === "ask" && topic !== undefined && action.topic === topic) {
      actions.push({ kind: "ask", topic });
    }
    if ((action.kind === "read" || action.kind === "edit") && typeof action.path === "string") {
      const offset = relative(workspace, resolve(workspace, action.path));
      if (offset && !isAbsolute(offset) && offset !== ".." && !offset.startsWith(".." + sep)) {
        actions.push({ kind: action.kind, path: offset.split(sep).join("/") });
      } else if (action.kind === "edit") {
        // The clarification grader rejects edits even when the native path is outside the fixture.
        actions.push({ kind: "edit", path: "[outside the fixture]" });
      }
    }
  }
  return actions;
}
