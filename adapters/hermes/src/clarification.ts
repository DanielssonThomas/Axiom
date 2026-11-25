import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { BackendRequest } from "@axiom/contracts";
import { openHermesGateway } from "./process.js";

type Launch = Parameters<typeof openHermesGateway>[0];
type Action = { kind: "read" | "edit"; path: string } | { kind: "ask"; topic: string };
interface Prompt { id: string; generation: number; question: string }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);

export function visibleHermesQuestionMark(finalOutput: unknown, events: readonly Record<string, unknown>[]) {
  const hasQuestionMark = (text: unknown) => typeof text === "string" && /[?？]/u.test(text);
  return hasQuestionMark(finalOutput) || events.some((event) =>
    (event.event === "message.delta" && hasQuestionMark(event.delta)) ||
    (event.event === "message.interim" && hasQuestionMark(event.text)));
}

export async function localHermesPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  try {
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("No local gateway port was available.");
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
}

function observations(events: readonly Record<string, unknown>[], receipts: readonly Record<string, unknown>[],
  answered: ReadonlyMap<string, Prompt>, classify: (question: string) => string | undefined): Action[] | undefined {
  const actions: Action[] = [];
  const seen = new Set<string>();
  const tools = new Map<unknown, Record<string, unknown>>();
  for (const receipt of receipts) {
    if (typeof receipt.id !== "string" || tools.has(receipt.id)) return;
    tools.set(receipt.id, receipt);
    if (receipt.kind === "edit") actions.push({ kind: "edit", path: "[native file change]" });
  }
  for (const [index, event] of events.entries()) {
    const receipt = tools.get(event.tool_call_id);
    if (event.event === "tool.completed" && event.tool === "read_file" && event.error === false &&
        receipt?.tool === "read_file" && receipt.kind === "read") {
      actions.push({ kind: "read", path: "issue.txt" });
    }
    if (event.event !== "clarify.request" || typeof event.prompt_id !== "string") continue;
    const prompt = answered.get(event.prompt_id);
    if (!prompt || seen.has(prompt.id) || event.question !== prompt.question || event.execution_generation !== prompt.generation) return;
    const settled = events.findIndex((next, position) => position > index && next.event === "clarify.settled" &&
      next.prompt_id === prompt.id && next.execution_generation === prompt.generation);
    if (settled < 0 || !events.slice(settled + 1).some((next) =>
      next.event === "tool.completed" && next.tool === "clarify" && next.error === false)) return;
    seen.add(prompt.id);
    const topic = classify(prompt.question.replace(/\nReply "skip" to skip this question\.$/, ""));
    if (topic) actions.push({ kind: "ask", topic });
  }
  if (seen.size !== answered.size) return;
  return actions;
}

export async function runHermesClarification(launch: Launch, directory: string, profile: string, request: BackendRequest,
  provider: string, observation: string, classify: (question: string) => string | undefined) {
  const port = await localHermesPort();
  const key = randomUUID();
  const gateway = await openHermesGateway({
    ...launch,
    env: { ...launch.env, HERMES_NO_SYSTEMD: "1", API_SERVER_ENABLED: "true", API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: String(port), API_SERVER_KEY: key },
  }, directory, profile, true);
  if ("interrupted" in gateway) return;
  const signal = AbortSignal.any([launch.signal, gateway.signal]);
  const json = async (path: string, body?: object) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]), redirect: "error",
      headers: { Authorization: `Bearer ${key}`, ...(body && { "Content-Type": "application/json" }) },
      ...(body && { method: "POST", body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error("Hermes rejected a local Runs API operation.");
    return response;
  };
  try {
    // Gateway readiness covers its process. The API listener can become ready a little later.
    while (!await json("/v1/capabilities").then(() => true, () => false)) await delay(50, undefined, { signal });
    const session = randomUUID();
    const run = record(await (await json("/v1/runs", { session_id: session, input: request.prompt })).json()).run_id;
    if (typeof run !== "string" || !/^run_[a-f0-9]+$/.test(run)) return;
    const route = `/v1/runs/${run}`;
    const answered = new Map<string, Prompt>();
    let admission: string | undefined;
    let finalOutput: unknown;
    while (true) {
      const state = record(await (await json(route)).json());
      if (state.run_id !== run || state.session_id !== session) return;
      if (typeof state.admission_id === "string" && state.admission_id) {
        if (admission !== undefined && admission !== state.admission_id) return;
        admission = state.admission_id;
      }
      if (typeof state.status === "string" && terminal.has(state.status)) {
        const runtime = record(state.runtime);
        if (state.status !== "completed" || !admission || (runtime.model && runtime.model !== request.host.model) ||
            (runtime.provider && runtime.provider !== provider)) return;
        finalOutput = state.output;
        break;
      }
      if (Array.isArray(state.pending_controls) && state.pending_controls.length) {
        if (!admission || state.pending_controls.length !== 1) return;
        const pending = record(state.pending_controls[0]);
        const { prompt_id, execution_generation, question } = pending;
        if (pending.kind !== "clarify" || typeof prompt_id !== "string" || !/^[a-f0-9]+$/.test(prompt_id) ||
            typeof execution_generation !== "number" || !Number.isSafeInteger(execution_generation) ||
            execution_generation !== state.execution_generation || typeof question !== "string") return;
        if (!answered.has(prompt_id)) {
          const settled = record(await (await json(route + "/clarify", {
            request_id: prompt_id, execution_generation, answer: "",
          })).json());
          if (settled.status !== "resolved" || settled.run_id !== run || settled.prompt_id !== prompt_id) return;
          answered.set(prompt_id, { id: prompt_id, question, generation: execution_generation });
        }
      }
      await delay(50, undefined, { signal });
    }
    const stream = await (await json(route + "/events")).text();
    const events = stream.split("\n").filter((line) => line.startsWith("data: "))
      .map((line) => record(JSON.parse(line.slice(6))));
    if (events.at(-1)?.event !== "run.completed" || events.some((event, index) => event.run_id !== run || event.seq !== index)) return;
    const receipts = (await readFile(observation, "utf8")).split("\n").filter(Boolean).map((line) => record(JSON.parse(line)));
    // The pinned Runs API can omit the served model even for a completed turn.
    const models = receipts.filter(({ kind }) => kind === "served-model");
    if (models.length !== 1 || models[0]?.model !== request.host.model) return;
    const actions = observations(events, receipts.filter(({ kind }) => kind !== "served-model"), answered, classify);
    if (actions) return { actions, blockingControls: answered.size, settledBlockingControls: answered.size,
      assistantMessageHasQuestionMark: visibleHermesQuestionMark(finalOutput, events) };
  } finally {
    await gateway.stop();
  }
}
