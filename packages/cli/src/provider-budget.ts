import { chmod } from "node:fs/promises";
import { createServer } from "node:http";
import type { Usage } from "@axiom/contracts";

export const benchmarkModel = "claude-haiku-4-5-20251001";
// The pinned model's standard Messages API context window. No beta extension or server tool is forwarded.
export const inputReservation = 200_000;
export const benchmarkTools = ["Read", "Glob", "Grep", "Edit", "Write", "Skill"] as const;
const localToolNames: ReadonlySet<string> = new Set(benchmarkTools);

export type MessagesTransport = (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>;

export function anthropicMessages(key: string): MessagesTransport {
  return (body, signal) => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", redirect: "error", signal, body: JSON.stringify(body),
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key },
  });
}

const fields = new Set(["model", "messages", "system", "tools", "tool_choice", "max_tokens", "stream",
  "temperature", "top_p", "top_k", "stop_sequences", "metadata", "thinking", "output_config", "context_management"]);
const object = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const tokens = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function admit(raw: unknown, outputLimit: number): Record<string, unknown> | undefined {
  const body = object(raw);
  if (body.model !== benchmarkModel || !Array.isArray(body.messages) || body.stream !== true ||
      !tokens(body.max_tokens) || body.max_tokens === 0 || Object.keys(body).some((key) => !fields.has(key))) return;
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool) => {
    const { type, name, input_schema, ...settings } = object(tool);
    return (type !== undefined && type !== "custom") || typeof name !== "string" ||
      !Object.keys(object(input_schema)).length ||
      Object.keys(settings).some((key) => !["description", "cache_control", "strict"].includes(key));
  }))) return;
  // Run standard Messages without server context edits or an independently variable thinking allocation.
  const { context_management: _contextManagement, thinking: _thinking, ...standard } = body;
  return { ...standard, max_tokens: Math.min(body.max_tokens, outputLimit) };
}

function meter(text: string) {
  let input: number | undefined;
  let output: number | undefined;
  let stopped = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const event = object(JSON.parse(line.slice(5)));
    if (stopped || event.type === "error") return;
    if (event.type === "message_start") {
      if (input !== undefined) return;
      const message = object(event.message);
      const usage = object(message.usage);
      const counts = [usage.input_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0];
      if (message.model !== benchmarkModel || !counts.every(tokens)) return;
      input = counts.reduce((total, amount) => total + amount, 0);
    } else if (event.type === "message_delta") {
      const count = object(event.usage).output_tokens;
      if (!tokens(count) || count < (output ?? 0)) return;
      output = count;
    } else if (event.type === "message_stop") {
      stopped = true;
    }
  }
  if (stopped && tokens(input) && tokens(output)) return { input, output };
}

export async function openProviderBudget(
  socketPath: string, tokenLimit: number, outputLimit: number, upstream: MessagesTransport, signal?: AbortSignal,
) {
  if (!tokens(tokenLimit) || !tokens(outputLimit) || outputLimit < 1 || outputLimit > 8_192) {
    throw new Error("Invalid provider limits.");
  }
  signal?.throwIfAborted();
  const closed = new AbortController();
  const deadline = signal ? AbortSignal.any([signal, closed.signal]) : closed.signal;
  let inputTokens = 0;
  let outputTokens = 0;
  let busy = false;
  let uncertain = false;
  let refused = false;
  let submitted = 0;
  let unfamiliarTools = 0;
  const server = createServer(async (request, response) => {
    const reject = (code: number) => response.writeHead(code, { "content-type": "application/json", connection: "close" })
      .end('{"type":"error","error":{"type":"invalid_request_error","message":"Axiom provider request unavailable."}}');
    if (request.method !== "POST" || !/^\/v1\/messages(?:\?beta=true)?$/.test(request.url ?? "")) {
      request.resume();
      return reject(403);
    }
    let body;
    try {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of request as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) return reject(413);
        parts.push(chunk);
      }
      body = admit(JSON.parse(Buffer.concat(parts).toString("utf8")), outputLimit);
    } catch { return reject(400); }
    if (!body) return reject(403);
    const max = body.max_tokens as number;
    if (deadline.aborted || busy || uncertain || tokenLimit - inputTokens - outputTokens < inputReservation + max) {
      refused = true;
      return reject(429);
    }
    busy = true;
    submitted++;
    if ((body.tools as unknown[] | undefined)?.some((tool) => !localToolNames.has(String(object(tool).name)))) {
      unfamiliarTools++;
    }
    try {
      const reply = await upstream(body, deadline);
      if (!reply.ok || !reply.body || !reply.headers.get("content-type")?.startsWith("text/event-stream")) {
        await reply.body?.cancel();
        throw new Error("No metered provider stream.");
      }
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of reply.body) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error("Provider response exceeded its buffer.");
        parts.push(chunk);
      }
      const payload = Buffer.concat(parts);
      const actual = meter(payload.toString("utf8"));
      if (!actual || actual.input > inputReservation || actual.output > max) throw new Error("Invalid provider usage.");
      inputTokens += actual.input;
      outputTokens += actual.output;
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" }).end(payload);
    } catch {
      // A submitted request may have incurred usage. Stop instead of releasing an unverified reservation.
      uncertain = true;
      reject(502);
    } finally {
      busy = false;
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600).catch(async (error: unknown) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>((resolve) => {
    closed.abort();
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return {
    socketPath,
    close,
    get refused() { return refused; },
    toolSurface() { return { submitted, unfamiliarTools }; },
    usage(): Usage {
      return uncertain || busy ? { metering: "unknown", reason: "A submitted provider request lacks complete usage." }
        : { metering: "reported", inputTokens, outputTokens };
    },
  };
}
