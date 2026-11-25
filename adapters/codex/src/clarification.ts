import type { BackendRequest } from "@axiom/contracts";
import { object, runCodex, type CodexProfile } from "./process.js";

export interface CodexPlanTurn {
  workspace: string;
  threadId: string;
  turnId: string;
  caseId: string;
}

export type CodexPlanObserver = (messages: readonly unknown[], turn: CodexPlanTurn) => readonly unknown[] | undefined;

export async function runCodexPlan(profile: CodexProfile, request: BackendRequest, signal: AbortSignal, observe: CodexPlanObserver) {
  let threadId: string | undefined;
  let turnId: string | undefined;
  let completed = false;
  const messages: unknown[] = [];
  const answered = new Set<string | number>();
  const result = await runCodex(profile, ["app-server", "--stdio"], {
    signal, experimentalApi: true,
    onLine(line, send, end) {
      const message = object(JSON.parse(line));
      const { id, method } = message;
      const params = object(message.params);
      const reply = object(message.result);
      if (method === undefined && (id === 1 || id === 2 || id === 3)) {
        if (message.error || !message.result) throw new Error("The Codex app-server refused its native setup.");
        if (id === 1) {
          send({ method: "initialized" });
          // Omit the legacy sandbox field so the staged restrictive permission profile applies.
          send({ id: 2, method: "thread/start", params: { cwd: profile.workspace, model: request.host.model,
            approvalPolicy: "never", ephemeral: true } });
        } else if (id === 2) {
          const native = object(reply.thread).id;
          if (typeof native !== "string" || reply.cwd !== profile.workspace || reply.model !== request.host.model) {
            throw new Error("The Codex app-server selected different thread settings.");
          }
          threadId = native;
          send({ id: 3, method: "turn/start", params: { threadId, input: [{ type: "text", text: request.prompt }],
            collaborationMode: { mode: "plan", settings: { model: request.host.model, reasoning_effort: null, developer_instructions: null } } } });
        } else {
          const native = object(reply.turn).id;
          if (typeof native !== "string") throw new Error("The Codex app-server did not admit the turn.");
          turnId = native;
        }
        return;
      }
      if (params.threadId === threadId && threadId !== undefined) messages.push(message);
      if (method === "item/tool/requestUserInput") {
        if (threadId === undefined || turnId === undefined || params.threadId !== threadId || params.turnId !== turnId ||
            params.isBlocking !== true || (typeof id !== "string" && typeof id !== "number") || answered.has(id)) {
          throw new Error("The Codex app-server question did not match the authorized turn.");
        }
        answered.add(id);
        send({ id, result: { answers: {} } });
      } else if (method === "turn/completed" && threadId !== undefined && params.threadId === threadId &&
          turnId !== undefined && object(params.turn).id === turnId) {
        completed = object(params.turn).status === "completed";
        end();
      } else if (typeof method === "string" && (typeof id === "number" || typeof id === "string")) {
        throw new Error("The Codex app-server requested an unsupported control.");
      }
    },
  });
  if (result.code !== 0 || !completed || !threadId || !turnId) return;
  return observe(messages, { workspace: profile.workspace, threadId, turnId, caseId: request.caseId });
}
