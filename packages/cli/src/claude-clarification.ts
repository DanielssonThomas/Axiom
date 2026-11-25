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

export function supportsClarification(item: EvaluationCase): boolean {
  const required = item.assertions.filter((assertion) => assertion.required);
  return item.version === "1" && topics.has(item.id) && item.requiredCapabilities.length === 1
    && item.requiredCapabilities[0] === "action-trace" && required.length > 0
    && required.every(({ grader }) => grader === "trace.clarify-before-edit");
}

export function clarificationTopic(caseId: string) {
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

export function admittedClarification(cases: readonly EvaluationCase[]) {
  const admitted = new Set(cases.filter(supportsClarification).map(({ id }) => id));
  return (caseId: string) => admitted.has(caseId) ? clarificationTopic(caseId) : undefined;
}

export async function readClaudeClarification(store: EvidenceStore, execution: BackendResult, workspace: string,
  evaluation: EvaluationCase): Promise<GradingAction[] | undefined> {
  if (!supportsClarification(evaluation)) return;
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

export async function readNativeClarification(store: EvidenceStore, execution: BackendResult, evaluation: EvaluationCase):
  Promise<GradingAction[] | undefined> {
  const surface = execution.host?.surface;
  if (!supportsClarification(evaluation) || (surface !== "app-server-plan" && surface !== "gateway-runs")) return;
  const location = `${execution.requestId}.clarification.json`;
  const receipt = execution.artifacts.find((item) => item.kind === "native-clarification" && item.location === location);
  if (!receipt || (await store.artifact({ kind: receipt.kind, path: location }))?.digest !== receipt.digest) return;
  const bytes = await readFile(join(store.directory, location));
  if (sha256(bytes) !== receipt.digest) return;
  const value = JSON.parse(bytes.toString("utf8")) as { requestId?: unknown; surface?: unknown; actions?: unknown };
  if (value.requestId !== execution.requestId || value.surface !== surface || !Array.isArray(value.actions)) return;
  const expectedTopic = topics.get(evaluation.id)?.topic;
  const actions: GradingAction[] = [];
  for (const item of value.actions) {
    if (!item || typeof item !== "object") return;
    const { kind, path, topic } = item as { kind?: unknown; path?: unknown; topic?: unknown };
    if ((kind === "read" && path === "issue.txt") || (kind === "edit" && path === "[native file change]")) {
      actions.push({ kind, path });
    } else if (kind === "ask" && typeof topic === "string" && topic === expectedTopic) {
      actions.push({ kind, topic });
    } else return;
  }
  return actions;
}
