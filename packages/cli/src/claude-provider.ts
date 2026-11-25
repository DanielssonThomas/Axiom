import { chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import type { Usage } from "@axiom/contracts";

export const benchmarkModel = "claude-haiku-4-5-20251001";
export const benchmarkTools = ["Read", "Glob", "Grep", "Edit", "Write", "Skill"] as const;
const localToolNames: ReadonlySet<string> = new Set(benchmarkTools);

export type MessagesTransport = (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>;
const anthropicTransports = new WeakSet<MessagesTransport>();

export function providerRoute(transport: MessagesTransport) {
  return anthropicTransports.has(transport) ? "anthropic-messages" as const : "injected" as const;
}

export function anthropicMessages(key: string): MessagesTransport {
  const transport: MessagesTransport = (body, signal) => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", redirect: "error", signal, body: JSON.stringify(body),
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key },
  });
  anthropicTransports.add(transport);
  return transport;
}

const fields = new Set(["model", "messages", "system", "tools", "tool_choice", "max_tokens", "stream",
  "temperature", "top_p", "top_k", "stop_sequences", "metadata", "thinking", "output_config", "context_management"]);
const object = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const tokens = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function admit(raw: unknown): Record<string, unknown> | undefined {
  const body = object(raw);
  if (body.model !== benchmarkModel || !Array.isArray(body.messages) || body.stream !== true ||
      !tokens(body.max_tokens) || body.max_tokens === 0 || Object.keys(body).some((key) => !fields.has(key))) return;
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool) => {
    const { type, name, input_schema, ...settings } = object(tool);
    return (type !== undefined && type !== "custom") || typeof name !== "string" ||
      !Object.keys(object(input_schema)).length ||
      Object.keys(settings).some((key) => !["description", "cache_control", "strict"].includes(key));
  }))) return;
  // Run standard Messages without server-managed context edits.
  const { context_management: _contextManagement, ...standard } = body;
  return standard;
}

function providerUsage() {
  let input: number[] | undefined;
  let output: number | undefined;
  let stopped = false;
  let invalid = false;
  function observe(line: string): boolean {
    if (!line.startsWith("data:")) return true;
    const event = object(JSON.parse(line.slice(5)));
    if (stopped || event.type === "error") return false;
    if (event.type === "message_start") {
      if (input !== undefined) return false;
      const message = object(event.message);
      const usage = object(message.usage);
      const counts = [usage.input_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0];
      if (message.model !== benchmarkModel || !counts.every(tokens)) return false;
      input = counts;
    } else if (event.type === "message_delta") {
      const previous = input;
      if (!previous) return false;
      const usage = object(event.usage);
      const counts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]
        .map((count, index) => count ?? previous[index]);
      if (!counts.every(tokens) || counts.some((count, index) => count < previous[index]!)) return false;
      if (!tokens(usage.output_tokens) || usage.output_tokens < (output ?? 0)) return false;
      input = counts;
      output = usage.output_tokens;
    } else if (event.type === "message_stop") {
      stopped = true;
    }
    return true;
  }
  return {
    async *stream(source: AsyncIterable<Uint8Array>) {
      const decoder = new TextDecoder();
      let partial = "";
      for await (const chunk of source) {
        if (!invalid) {
          const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n");
          partial = lines.pop()!;
          try { invalid = !lines.every(observe); } catch { invalid = true; }
        }
        yield chunk;
      }
      if (!invalid) {
        try { invalid = !observe(partial + decoder.decode()); } catch { invalid = true; }
      }
    },
    read() {
      const total = input?.reduce((sum, amount) => sum + amount, 0);
      if (!invalid && stopped && tokens(total) && tokens(output)) return { input: total, output };
    },
  };
}

export async function openClaudeProvider(socketPath: string, upstream: MessagesTransport, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const closed = new AbortController();
  const deadline = signal ? AbortSignal.any([signal, closed.signal]) : closed.signal;
  let inputTokens = 0;
  let outputTokens = 0;
  let busy = false;
  let unmeasured = 0;
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
      body = admit(JSON.parse(Buffer.concat(parts).toString("utf8")));
    } catch { return reject(400); }
    if (!body) return reject(403);
    if (deadline.aborted || busy) return reject(429);
    busy = true;
    submitted++;
    if ((body.tools as unknown[] | undefined)?.some((tool) => !localToolNames.has(String(object(tool).name)))) {
      unfamiliarTools++;
    }
    try {
      const reply = await upstream(body, deadline);
      if (!reply.ok || !reply.body || !reply.headers.get("content-type")?.startsWith("text/event-stream")) {
        await reply.body?.cancel();
        throw new Error("No provider stream.");
      }
      const usage = providerUsage();
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      await pipeline(usage.stream(reply.body), response, { signal: deadline });
      const actual = usage.read();
      if (actual) {
        inputTokens += actual.input;
        outputTokens += actual.output;
      } else unmeasured++;
    } catch {
      unmeasured++;
      if (!response.headersSent && !response.destroyed) reject(502);
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
    toolSurface() { return { submitted, unfamiliarTools }; },
    snapshot() { return { inputTokens, outputTokens, unmeasured }; },
    usage(since = { inputTokens: 0, outputTokens: 0, unmeasured: 0 }): Usage {
      return unmeasured !== since.unmeasured || busy
        ? { metering: "unknown", reason: "A submitted provider request lacks complete usage." }
        : { metering: "reported", inputTokens: inputTokens - since.inputTokens, outputTokens: outputTokens - since.outputTokens };
    },
  };
}
