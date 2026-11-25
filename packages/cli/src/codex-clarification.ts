import { isAbsolute, resolve } from "node:path";
import type { GradingAction } from "@axiom/graders";
import { clarificationTopic } from "./claude-clarification.js";

interface ClarificationTurn {
  workspace: string;
  threadId: string;
  turnId: string;
  caseId: string;
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

function issueRead(item: Record<string, unknown>, workspace: string) {
  const { cwd } = item;
  return item.type === "commandExecution" && item.status === "completed" && item.exitCode === 0 &&
    typeof cwd === "string" && isAbsolute(cwd) && Array.isArray(item.commandActions) &&
    item.commandActions.map(record).some(({ type, path }) =>
      type === "read" && typeof path === "string" && resolve(cwd, path) === resolve(workspace, "issue.txt"));
}

/** Correlate native observations for the one ephemeral app-server turn owned by the verifier. */
export function codexClarificationActions(messages: readonly unknown[], turn: ClarificationTurn): GradingAction[] | undefined {
  const classify = clarificationTopic(turn.caseId);
  if (!classify) return;
  const actions: { action: GradingAction; requestId?: string | number }[] = [];
  const pending = new Set<string | number>();
  const resolved = new Set<string | number>();
  for (const raw of messages) {
    const { id, method, params: rawParams } = record(raw);
    const params = record(rawParams);
    if (params.threadId !== turn.threadId) continue;
    if (method === "turn/completed") {
      const terminal = record(params.turn);
      if (terminal.id !== turn.turnId) continue;
      if (terminal.status !== "completed") return;
      return actions.filter(({ requestId }) => requestId === undefined || resolved.has(requestId)).map(({ action }) => action);
    }
    if (method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if ((typeof requestId === "number" || typeof requestId === "string") && pending.delete(requestId)) resolved.add(requestId);
      continue;
    }
    if (params.turnId !== turn.turnId) continue;
    const item = record(params.item);
    if ((method === "item/started" || method === "item/completed") && item.type === "fileChange") {
      actions.push({ action: { kind: "edit", path: "[native file change]" } });
    }
    if (method === "item/completed" && issueRead(item, turn.workspace)) {
      actions.push({ action: { kind: "read", path: "issue.txt" } });
    }
    if (method !== "item/tool/requestUserInput" || params.isBlocking !== true || typeof params.itemId !== "string" ||
        !params.itemId.length || !Array.isArray(params.questions) ||
        (typeof id !== "string" && typeof id !== "number")) continue;
    if (typeof id === "string" ? !id.length : !Number.isSafeInteger(id)) continue;
    if (pending.has(id) || resolved.has(id)) return;
    pending.add(id);
    for (const { question } of params.questions.map(record)) {
      const topic = typeof question === "string" ? classify(question) : undefined;
      if (topic) actions.push({ action: { kind: "ask", topic }, requestId: id });
    }
  }
}
