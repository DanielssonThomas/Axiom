import { array, object } from "./runtime.js";

export type ClarificationTopic = (question: string) => string | undefined;
export interface WithheldQuestion { toolUseId: string; topic: string }
export const withheldAnswer = "No user answer was provided.";

/** Deny permission without supplying a decision. Only the native question channel contributes a candidate. */
export function clarificationExchange(classify: ClarificationTopic) {
  const requests = new Set<string>();
  const questions = new Map<string, WithheldQuestion>();
  return { questions, respond(event: Record<string, unknown>) {
    if (event.type !== "control_request" || typeof event.request_id !== "string") return;
    const id = event.request_id;
    if (requests.has(id)) throw new Error("Duplicate native Claude control request.");
    requests.add(id);
    const request = object(event.request);
    if (request.subtype !== "can_use_tool") {
      return { type: "control_response", response: { subtype: "error", request_id: id, error: "Unsupported control request." } };
    }
    const input = object(request.input);
    const [candidate, ...other] = array(input.questions).map(object);
    if (request.tool_name === "AskUserQuestion" && request.requires_user_interaction === true && typeof request.tool_use_id === "string"
        && input.answers === undefined && other.length === 0 && typeof candidate?.question === "string") {
      const topic = classify(candidate.question);
      if (topic) questions.set(id, { toolUseId: request.tool_use_id, topic });
    }
    return { type: "control_response", response: { subtype: "success", request_id: id,
      response: { behavior: "deny", message: withheldAnswer, interrupt: false } } };
  } };
}
