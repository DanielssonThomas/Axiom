import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";

export type NativeHost = "claude" | "codex" | "hermes";
export const ordinaryPrompt = "Acknowledge this disposable native session.";

export interface RequestObservation {
  model: string;
  text: string;
  toolResults: string[];
}

interface FixtureTool {
  name: string;
  arguments: string;
}

interface ProtocolReply {
  protocol: NativeHost;
  model: string;
  requestNumber: number;
  tool?: FixtureTool;
}

function send(response: ServerResponse, { protocol, model, requestNumber, tool }: ProtocolReply) {
  const text = "Native fixture acknowledged.";
  response.setHeader("content-type", "text/event-stream");
  const frame = (data: object, event?: string) => response.write(
    (event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`,
  );
  if (protocol === "claude") {
    const content = tool ? { type: "tool_use", id: `toolu_fixture_${requestNumber}`, name: tool.name, input: {} }
      : { type: "text", text: "" };
    const delta = tool ? { type: "input_json_delta", partial_json: tool.arguments } : { type: "text_delta", text };
    const events = [
      { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [],
        model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: content },
      { type: "content_block_delta", index: 0, delta },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    for (const event of events) frame(event, event.type);
  } else if (protocol === "codex") {
    const message = {
      id: "msg_fixture", type: "message", role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }], status: "completed",
    };
    const responseId = `resp_fixture_${requestNumber}`;
    const call = tool && { id: `item_fixture_${requestNumber}`, type: "function_call", status: "completed",
      call_id: `call_fixture_${requestNumber}`, ...tool };
    const items = call ? [
      { type: "response.output_item.added", item: call, output_index: 0 },
      { type: "response.output_item.done", item: call, output_index: 0 },
    ] : [
      { type: "response.output_item.added", item: { ...message, content: [], status: "in_progress" } },
      { type: "response.output_text.delta", delta: text, item_id: message.id, output_index: 0, content_index: 0 },
      { type: "response.output_item.done", item: message },
    ];
    for (const event of [
      { type: "response.created", response: { id: responseId } }, ...items,
      { type: "response.completed", response: { id: responseId, status: "completed",
        usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 } } },
    ]) frame(event);
  } else {
    const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model };
    frame({ ...chunk, choices: [{ index: 0, finish_reason: null, delta: tool ? {
      role: "assistant", tool_calls: [{ index: 0, id: `call-fixture-${requestNumber}`, type: "function", function: tool }],
    } : { role: "assistant", content: text } }] });
    frame({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] });
    frame({ ...chunk, choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } });
    response.write("data: [DONE]\n\n");
  }
  response.end();
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
}

/** Used only for transport evidence. The synthetic responses make no decisions about Axiom policy. */
export async function openLoopback(protocol: NativeHost, model: string,
  script?: (observation: RequestObservation) => FixtureTool | undefined) {
  const requests: RequestObservation[] = [];
  let nextHermesTool: (() => Promise<FixtureTool>) | undefined;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model", owned_by: "fixture" }] }));
        return;
      }
      let input = "";
      request.setEncoding("utf8");
      for await (const part of request) {
        input += part;
        if (input.length > 2 * 1024 * 1024) throw new Error("The native fixture request is oversized.");
      }
      const body: unknown = JSON.parse(input);
      const requestedModel = body && typeof body === "object" && "model" in body ? body.model : undefined;
      if (typeof requestedModel !== "string") throw new Error("The native fixture request did not include a model.");
      const messages = body && typeof body === "object" && "messages" in body ? body.messages : undefined;
      const responsesInput = body && typeof body === "object" && "input" in body ? body.input : undefined;
      const toolResults = protocol === "codex" && Array.isArray(responsesInput) ? responsesInput.flatMap((item) =>
        item?.type === "function_call_output" ? [strings(item.output).join("\n")] : [],
      ) : Array.isArray(messages) ? messages.flatMap((message) =>
        message?.role === "tool" && typeof message.content === "string" ? [message.content]
          : protocol === "claude" && message?.role === "user" && Array.isArray(message.content)
            ? message.content.filter((part: { type?: string }) => part?.type === "tool_result").map((part: unknown) => strings(part).join("\n"))
            : [],
      ) : [];
      const observation = { model: requestedModel, text: strings(body).join("\n"), toolResults };
      requests.push(observation);
      const tool = nextHermesTool;
      nextHermesTool = undefined;
      const call = tool ? await tool() : script?.(observation);
      send(response, { protocol, model, requestNumber: requests.length, ...(call && { tool: call }) });
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The loopback fixture could not start.");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    respondWithHermesTool(action: () => Promise<FixtureTool>) {
      if (protocol !== "hermes" || nextHermesTool) throw new Error("Invalid fixture tool schedule.");
      nextHermesTool = action;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export type NativeLoopback = Awaited<ReturnType<typeof openLoopback>>;
