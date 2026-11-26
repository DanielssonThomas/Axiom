import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { benchmarkModel, openClaudeProvider, type MessagesTransport } from "../../packages/cli/src/claude-provider.js";

function completion(input: number, output: number, cacheRead = 0) {
  return new Response([
    { type: "message_start", message: { model: benchmarkModel, usage: {
      input_tokens: input, output_tokens: 0, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0,
    } } },
    { type: "message_delta", usage: { input_tokens: input + 1, cache_read_input_tokens: cacheRead + 1,
      cache_creation_input_tokens: null, output_tokens: output } },
    { type: "message_stop" },
  ].map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function send(socketPath: string, body: Record<string, unknown>, path = "/v1/messages?beta=true") {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request({ socketPath, path, method: "POST" }, (incoming) => {
      incoming.resume();
      incoming.on("end", () => resolve(incoming.statusCode!));
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify({ model: benchmarkModel, messages: [{ role: "user", content: "fixture" }],
      stream: true, max_tokens: 1_000, ...body }));
  });
}

test.runIf(process.platform === "linux")("checks the Messages surface, forwards the native output setting and reports usage", async () => {
  const folder = await mkdtemp(join(tmpdir(), "axiom-provider-"));
  const upstream = vi.fn<MessagesTransport>(async () => completion(10, 2, 20));
  const provider = await openClaudeProvider(join(folder, "model.sock"), upstream);
  try {
    expect(await send(provider.socketPath, {}, "/v1/models")).toBe(403);
    expect(await send(provider.socketPath, { tools: [{ type: "web_search_20250305", name: "search" }] })).toBe(403);
    expect(await send(provider.socketPath, { model: "different-model" })).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    const thinking = { type: "enabled", budget_tokens: 10_000 };
    expect(await send(provider.socketPath, { max_tokens: 20_000, context_management: { edits: [] }, thinking })).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0]).toHaveLength(2);
    expect(upstream).toHaveBeenCalledWith(expect.objectContaining({ model: benchmarkModel, max_tokens: 20_000, thinking }), expect.any(AbortSignal));
    expect(upstream.mock.calls[0]?.[0]).not.toHaveProperty("context_management");
    expect(provider.usage()).toEqual({ metering: "reported", inputTokens: 32, outputTokens: 2 });
    expect(await send(provider.socketPath, {})).toBe(200);
    expect(await send(provider.socketPath, {})).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(3);
  } finally {
    await provider.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test.runIf(process.platform === "linux")("forwards responses with missing usage and admits subsequent requests", async () => {
  const folder = await mkdtemp(join(tmpdir(), "axiom-provider-"));
  const controller = new AbortController();
  const upstream = vi.fn<MessagesTransport>(async () => completion(10, 2))
    .mockResolvedValueOnce(new Response("private upstream detail", { status: 500 }))
    .mockResolvedValueOnce(new Response('data: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } }));
  const provider = await openClaudeProvider(join(folder, "model.sock"), upstream, controller.signal);
  try {
    expect(await send(provider.socketPath, {})).toBe(502);
    expect(await send(provider.socketPath, {})).toBe(200);
    const before = provider.snapshot();
    expect(await send(provider.socketPath, {})).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(provider.usage()).toMatchObject({ metering: "unknown" });
    expect(provider.usage(before)).toEqual({ metering: "reported", inputTokens: 12, outputTokens: 2 });
    controller.abort();
    expect(await send(provider.socketPath, {})).toBe(429);
  } finally {
    await provider.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test.runIf(process.platform === "linux")("cancels an in-flight provider call and retains unknown usage", async () => {
  const folder = await mkdtemp(join(tmpdir(), "axiom-provider-"));
  const controller = new AbortController();
  let enter!: () => void;
  const started = new Promise<void>((resolve) => { enter = resolve; });
  const upstream = vi.fn<MessagesTransport>(async (_body, signal) => {
    enter();
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const provider = await openClaudeProvider(join(folder, "model.sock"), upstream, controller.signal);
  try {
    const running = send(provider.socketPath, {});
    await started;
    controller.abort();
    expect(await running).toBe(502);
    expect(await send(provider.socketPath, {})).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(provider.usage()).toMatchObject({ metering: "unknown" });
  } finally {
    await provider.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test.runIf(process.platform === "linux")("cancels an abandoned provider stream and accepts the next call", async () => {
  const folder = await mkdtemp(join(tmpdir(), "axiom-provider-"));
  const cancel = vi.fn();
  const upstream = vi.fn<MessagesTransport>(async () => completion(10, 2)).mockResolvedValueOnce(new Response(
    new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('data: {"type":"ping"}\n\n')); },
      cancel,
    }),
    { headers: { "content-type": "text/event-stream" } },
  ));
  const provider = await openClaudeProvider(join(folder, "model.sock"), upstream);
  try {
    await new Promise<void>((resolve, reject) => {
      const outgoing = request({ socketPath: provider.socketPath, path: "/v1/messages", method: "POST" }, (incoming) => {
        incoming.once("data", () => {
          incoming.destroy();
          resolve();
        });
        incoming.on("error", reject);
      });
      outgoing.on("error", reject);
      outgoing.end(JSON.stringify({ model: benchmarkModel, messages: [], stream: true, max_tokens: 1_000 }));
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled(), { timeout: 1_000 });
    expect(upstream.mock.calls[0]?.[1].aborted).toBe(true);
    await vi.waitFor(async () => expect(await send(provider.socketPath, {})).toBe(200));
    expect(provider.usage()).toMatchObject({ metering: "unknown" });
  } finally {
    await provider.close();
    await rm(folder, { recursive: true, force: true });
  }
});
