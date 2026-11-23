import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { benchmarkModel, openProviderBudget, type MessagesTransport } from "../../packages/cli/src/provider-budget.js";

function completion(input: number, output: number, cacheRead = 0) {
  return new Response([
    { type: "message_start", message: { model: benchmarkModel, usage: {
      input_tokens: input, output_tokens: 0, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0,
    } } },
    { type: "message_delta", usage: { output_tokens: output } },
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

test.runIf(process.platform === "linux")("admits only bounded Messages requests and accounts for cache tokens", async () => {
  const folder = await mkdtemp(join(tmpdir(), "axiom-budget-"));
  const upstream = vi.fn<MessagesTransport>(async () => completion(10, 2, 20));
  const budget = await openProviderBudget(join(folder, "model.sock"), 200_100, 64, upstream);
  try {
    expect(await send(budget.socketPath, {}, "/v1/models")).toBe(403);
    expect(await send(budget.socketPath, { tools: [{ type: "web_search_20250305", name: "search" }] })).toBe(403);
    expect(await send(budget.socketPath, { model: "different-model" })).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(await send(budget.socketPath, { context_management: { edits: [] }, thinking: { type: "enabled" } })).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0]).toHaveLength(2);
    expect(upstream).toHaveBeenCalledWith(expect.objectContaining({ model: benchmarkModel, max_tokens: 64 }), expect.any(AbortSignal));
    expect(upstream.mock.calls[0]?.[0]).not.toHaveProperty("context_management");
    expect(upstream.mock.calls[0]?.[0]).not.toHaveProperty("thinking");
    expect(budget.usage()).toEqual({ metering: "reported", inputTokens: 30, outputTokens: 2 });
    expect(await send(budget.socketPath, {})).toBe(200);
    expect(await send(budget.socketPath, {})).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(2);
  } finally {
    await budget.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test.runIf(process.platform === "linux")("stops after ambiguous execution and cancellation without leaking upstream details", async () => {
  const folder = await mkdtemp(join(tmpdir(), "axiom-budget-"));
  const controller = new AbortController();
  const upstream = vi.fn(async () => new Response("private upstream detail", { status: 500 }));
  const budget = await openProviderBudget(join(folder, "model.sock"), 500_000, 64, upstream, controller.signal);
  try {
    expect(await send(budget.socketPath, {})).toBe(502);
    expect(budget.usage()).toMatchObject({ metering: "unknown" });
    expect(await send(budget.socketPath, {})).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(budget.usage()).toMatchObject({ metering: "unknown" });
  } finally {
    await budget.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test.runIf(process.platform === "linux")("cancels an in-flight provider call and retains unknown usage", async () => {
  const folder = await mkdtemp(join(tmpdir(), "axiom-budget-"));
  const controller = new AbortController();
  let enter!: () => void;
  const started = new Promise<void>((resolve) => { enter = resolve; });
  const upstream = vi.fn<MessagesTransport>(async (_body, signal) => {
    enter();
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const budget = await openProviderBudget(join(folder, "model.sock"), 500_000, 64, upstream, controller.signal);
  try {
    const running = send(budget.socketPath, {});
    await started;
    controller.abort();
    expect(await running).toBe(502);
    expect(await send(budget.socketPath, {})).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(budget.usage()).toMatchObject({ metering: "unknown" });
  } finally {
    await budget.close();
    await rm(folder, { recursive: true, force: true });
  }
});
