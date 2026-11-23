import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { assembleBundles, writeBundles } from "../../../packages/bundles/src/index.js";

const executable = process.env.AXIOM_HERMES_CLI;
const model = "fixture-model";
const compiled = new URL("../../../adapters/hermes/dist/index.js", import.meta.url).href;
const compiledProcess = new URL("../../../adapters/hermes/dist/process.js", import.meta.url).href;
const skills = ["context", "delegate", "design", "diagnose", "knowledge", "verify"];

function completion(response: ServerResponse, tool?: { name: string; arguments: string }) {
  response.setHeader("content-type", "text/event-stream");
  const frame = (choices: unknown[], usage?: Record<string, number>) => response.write(
    "data: " + JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", created: 1, model, choices, ...(usage && { usage }),
    }) + "\n\n",
  );
  frame([{ index: 0, finish_reason: null, delta: tool ? {
    role: "assistant",
    tool_calls: [{ index: 0, id: "call-fixture", type: "function",
      function: tool }],
  } : {
    role: "assistant", content: "fixture-complete",
  } }]);
  frame([{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }]);
  frame([], { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 });
  response.end("data: [DONE]\n\n");
}

test.runIf(executable)("loads and uses an installed skill in an ordinary session, withholds success on hook failures", async () => {
  const adapter: typeof import("../../../adapters/hermes/src/index.js") = await import(compiled);
  const nativeProcess: typeof import("../../../adapters/hermes/src/process.js") = await import(compiledProcess);
  const root = await realpath(await mkdtemp(join(tmpdir(), "ah-")));
  const home = join(root, "h");
  const workspace = join(root, "fixture");
  const archive = join(root, "evidence");
  const profile = { home, profile: "alpha" };
  const installed = join(home, "profiles", "alpha", "plugins", "axiom");
  const installedPolicy = join(installed, "core", "AXIOMS.md");
  const checker = join(installed, "checker.mjs");
  const heldChecker = join(root, "held-checker.mjs");
  let policyDigest = "";
  let observedPolicy = false;
  let mode: "skill" | "benchmark" | "missing" | "damaged" = "skill";
  let observedSkills: string[] = [];
  let toolResult: Record<string, unknown> | undefined;
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
    const messages: { role: string; content: string }[] = body.messages;
    const system = messages.filter(({ role, content }) => role === "system" && typeof content === "string");
    observedPolicy ||= system.some(({ content }) => content.includes(policyDigest));
    let tool;
    if (mode !== "benchmark" && !requestedTool) {
      requestedTool = true;
      tool = mode === "skill" ? { name: "skill_view", arguments: '{"name":"axiom:context"}' }
        : { name: "read_file", arguments: '{"path":"fixture.txt"}' };
      if (mode === "missing") await rename(checker, heldChecker);
      if (mode === "damaged") await writeFile(installedPolicy, "Intentionally damaged policy fixture.\n");
      if (mode === "skill") observedSkills = skills.filter((id) => system.some(({ content }) => content.includes(`axiom:${id}`)));
    } else {
      const response = messages.find(({ role }) => role === "tool");
      if (response) {
        toolResult = JSON.parse(response.content);
        if (mode === "missing") await rename(heldChecker, checker);
      }
    }
    completion(response, tool);
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
      selectedProfiles: [], checks: {}, skills: skills.map((id) => ({ id })), adapters: [adapter.hermesBundleAdapter],
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
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const launch = {
      executable: nativePath, cwd: workspace, deadline: performance.now() + 35_000,
      signal: new AbortController().signal,
      env: { HOME: home, HERMES_HOME: home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        OPENAI_API_KEY: "local-fixture-only", HERMES_DISABLE_AUTO_UPDATE: "1" },
    };
    const gateway = await nativeProcess.openHermesGateway({
      ...launch, args: ["gateway", "run", "--no-supervise", "--external-supervisor"],
    }, home, profile.profile);
    if ("interrupted" in gateway) throw new Error(`The native gateway could not start (${gateway.interrupted}).`);
    try {
      const ordinary = await nativeProcess.runHermes({
        ...launch, input: "Use the installed context skill, then respond.",
        args: ["--profile", "alpha", "chat", "--query-file", "-", "--format", "stream-json",
          "--model", model, "--provider", "custom", "--max-turns", "3", "--base-url", baseUrl],
      });
      expect(ordinary.code).toBe(0);
      expect(observedSkills).toEqual(skills);
      expect(toolResult).toMatchObject({ success: true, name: "axiom:context" });
      expect(toolResult?.content).toContain("AX-01");
    } finally {
      await gateway.stop();
    }
    const ordinaryEvidence = join(home, "profiles", "alpha", ".axiom-hermes", "evidence", "acceptance");
    const recorded = await Promise.all((await readdir(ordinaryEvidence)).map(async (name) =>
      JSON.parse(await readFile(join(ordinaryEvidence, name), "utf8")),
    ));
    expect(recorded).toContainEqual(expect.objectContaining({
      criterionIds: ["hermes-pre-tool"], policy: artifact!.manifest.policy, outcome: { status: "passed" },
    }));

    const backend = new adapter.HermesBenchmarkBackend({
      executable: nativePath, profile, archiveDirectory: archive, provider: "custom", baseUrl, maxTurns: 3,
      environment: { OPENAI_API_KEY: "local-fixture-only", HERMES_DISABLE_AUTO_UPDATE: "1" },
    });
    const request = {
      id: "native-hermes", caseId: "native-fixture", workspace, policy: artifact!.manifest.policy,
      prompt: "Reply with fixture-complete.", mode: "with_axiom" as const, timeoutMs: 35_000,
      host: { agent: "hermes", version: adapter.hermesVersion, model, os: process.platform, surface: "cli" },
    };
    mode = "benchmark";
    const accepted = await backend.run(request, new AbortController().signal);
    expect(accepted.outcome).toEqual({ status: "passed" });
    expect(observedPolicy).toBe(true);
    expect(accepted.usage).toMatchObject({ metering: "reported", inputTokens: 9, outputTokens: 2 });
    const trace = JSON.parse(await readFile(join(archive, accepted.artifacts[0]!.location), "utf8"));
    expect(adapter.inspectHermesActivation(profile, trace.session).loaded.status).toBe("passed");
    const nativeState = JSON.parse(await readFile(join(home, "gateway_state.json"), "utf8"));
    expect(() => process.kill(nativeState.pid, 0)).toThrow();

    mode = "missing";
    requestedTool = false;
    const missing = await backend.run({ ...request, id: "native-missing" }, new AbortController().signal);
    expect(toolResult).toMatchObject({ error: expect.stringContaining("check is unavailable") });
    expect(missing.outcome).toMatchObject({ status: "blocked", reason: expect.stringContaining("check is unavailable") });

    mode = "damaged";
    requestedTool = false;
    const rejected = await backend.run({
      ...request, id: "native-veto", prompt: "Read the fixture file.",
    }, new AbortController().signal);
    expect(requestedTool).toBe(true);
    expect(rejected.outcome.status).toBe("failed");
    const evidence = await readdir(join(archive, "acceptance"));
    const outcomes = await Promise.all(evidence.map(async (name) =>
      JSON.parse(await readFile(join(archive, "acceptance", name), "utf8")).outcome,
    ));
    expect(outcomes).toContainEqual({ status: "failed", reason: expect.stringContaining("core/AXIOMS.md") });
    expect(adapter.changeHermesPlugin(profile, { kind: "uninstall" }).outcome.status).toBe("passed");
    expect(adapter.changeHermesPlugin(profile, { kind: "install", bundle: artifact!.directory }).outcome.status).toBe("passed");
    expect(adapter.inspectHermesActivation(profile, trace.session)).toMatchObject({
      installed: { status: "passed" }, discoverable: { status: "not_run" }, loaded: { status: "not_run" },
    });
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 150_000);
