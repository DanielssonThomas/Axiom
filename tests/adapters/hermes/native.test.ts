import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { assembleBundles, writeBundles } from "../../../packages/bundles/src/index.js";

const executable = process.env.AXIOM_HERMES_CLI;
const model = "fixture-model";
const compiled = new URL("../../../adapters/hermes/dist/index.js", import.meta.url).href;

function completion(response: ServerResponse, tool: boolean) {
  response.setHeader("content-type", "text/event-stream");
  const frame = (choices: unknown[], usage?: Record<string, number>) => response.write(
    "data: " + JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", created: 1, model, choices, ...(usage && { usage }),
    }) + "\n\n",
  );
  frame([{ index: 0, finish_reason: null, delta: tool ? {
    role: "assistant",
    tool_calls: [{ index: 0, id: "call-fixture", type: "function",
      function: { name: "read_file", arguments: '{"path":"fixture.txt"}' } }],
  } : {
    role: "assistant", content: "fixture-complete",
  } }]);
  frame([{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }]);
  frame([], { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 });
  response.end("data: [DONE]\n\n");
}

test.runIf(executable)("loads native Axiom context and vetoes a tool after an observed policy failure", async () => {
  const adapter: typeof import("../../../adapters/hermes/src/index.js") = await import(compiled);
  const root = await mkdtemp(join(tmpdir(), "ah-"));
  const home = join(root, "h");
  const workspace = join(root, "fixture");
  const archive = join(root, "evidence");
  const profile = { home, profile: "alpha" };
  const installedPolicy = join(home, "profiles/alpha/plugins/axiom/core/AXIOMS.md");
  let policyDigest = "";
  let observedPolicy = false;
  let damage = false;
  let requestedTool = false;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model", owned_by: "fixture" }] }));
      return;
    }
    if (!request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }

    let payload = "";
    for await (const chunk of request) payload += chunk.toString();
    const body = JSON.parse(payload);
    observedPolicy ||= body.messages.some((message: { role: string; content: unknown }) =>
      message.role === "system" && typeof message.content === "string" && message.content.includes(policyDigest)
    );
    const useTool = damage && !requestedTool;
    if (useTool) {
      requestedTool = true;
      await writeFile(installedPolicy, "Intentionally damaged policy fixture.\n");
    }
    completion(response, useTool);
  });

  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "fixture.txt"), "Fixture contents.\n");
    const nativePath = executable!;
    const created = spawnSync(nativePath, ["profile", "create", "alpha", "--no-alias", "--no-credentials"], {
      cwd: workspace, encoding: "utf8", timeout: 20_000,
      env: { HOME: root, HERMES_HOME: home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
    expect(created.status, created.stderr).toBe(0);
    const repository = fileURLToPath(new URL("../../../", import.meta.url));
    const [artifact] = writeBundles(join(root, "bundles"), assembleBundles(repository, {
      version: "0.1.0", sourceRevision: "hermes-native-test", policyVersion: "1",
      selectedProfiles: [], checks: {}, skills: [{ id: "context" }], adapters: [adapter.hermesBundleAdapter],
    }));
    policyDigest = artifact!.manifest.policy.digest;
    expect(adapter.changeHermesPlugin(profile, { kind: "install", bundle: artifact!.directory }).outcome)
      .toEqual({ status: "passed" });
    const listed = spawnSync(nativePath, ["--profile", "alpha", "plugins", "list", "--user", "--json"], {
      cwd: workspace, encoding: "utf8", timeout: 20_000,
      env: { HOME: root, HERMES_HOME: home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toContainEqual(expect.objectContaining({
      name: "axiom", version: artifact!.manifest.version, status: "enabled",
    }));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The loopback fixture could not start.");
    const backend = new adapter.HermesBenchmarkBackend({
      executable: nativePath, profile, archiveDirectory: archive, provider: "custom",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, maxTurns: 2,
      environment: { OPENAI_API_KEY: "local-fixture-only", HERMES_DISABLE_AUTO_UPDATE: "1" },
    });
    const request = {
      id: "native-hermes", caseId: "native-fixture", workspace, policy: artifact!.manifest.policy,
      prompt: "Reply with fixture-complete.", mode: "with_axiom" as const, timeoutMs: 35_000,
      host: { agent: "hermes", version: adapter.hermesVersion, model, os: process.platform, surface: "cli" },
    };
    const accepted = await backend.run(request, new AbortController().signal);
    expect(accepted.outcome).toEqual({ status: "passed" });
    expect(observedPolicy).toBe(true);
    expect(accepted.usage).toMatchObject({ metering: "reported", inputTokens: 9, outputTokens: 2 });
    const trace = JSON.parse(await readFile(join(archive, accepted.artifacts[0]!.location), "utf8"));
    expect(adapter.inspectHermesActivation(profile, trace.session).loaded.status).toBe("passed");
    const nativeState = JSON.parse(await readFile(join(home, "gateway_state.json"), "utf8"));
    expect(() => process.kill(nativeState.pid, 0)).toThrow();

    damage = true;
    const rejected = await backend.run({
      ...request, id: "native-veto", prompt: "Read the fixture file.",
    }, new AbortController().signal);
    expect(requestedTool).toBe(true);
    expect(rejected.outcome.status).not.toBe("passed");
    const evidence = await readdir(join(archive, "acceptance"));
    const outcomes = await Promise.all(evidence.map(async (name) =>
      JSON.parse(await readFile(join(archive, "acceptance", name), "utf8")).outcome,
    ));
    expect(outcomes).toContainEqual({ status: "failed", reason: expect.stringContaining("core/AXIOMS.md") });
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 85_000);
