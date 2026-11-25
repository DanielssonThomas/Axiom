import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import type { TaskBrief } from "@axiom/contracts";
import {
  assessCodexActivation, buildCodexBundle, configureCodexProfile, createCodexBackend, formatCodexWorkerBrief,
  observeCodexProfile, parseCodexTrace, supportedVersion, type CodexProviderObservation,
} from "../../../adapters/codex/src/index.js";
import { runCodex } from "../../../adapters/codex/src/process.js";
import { EvidenceStore, snapshotSource } from "../../../packages/evidence/src/index.js";
import { openLoopback } from "../../integration/hosts/loopback.js";

const executable = process.env.AXIOM_TEST_CODEX_BINARY;

test.runIf(executable && process.platform === "linux")("keeps the native model rejection on a nonzero Codex exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "axiom-codex-rejected-model-"));
  const workspace = join(root, "workspace");
  const artifacts = join(root, "archive");
  const canary = "synthetic-private-provider-detail";
  const requestedModels: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "a-different-model", object: "model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requestedModels.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).model);
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "unsupported_model", type: "invalid_request_error", message: canary } }));
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The disposable Codex provider did not start.");
    await mkdir(workspace);
    const backend = createCodexBackend({ program: executable!, artifacts, configToml: [
      'model_provider = "fixture"', "[model_providers.fixture]", 'name = "Disposable fixture"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`, 'wire_api = "responses"',
      "requires_openai_auth = false", "request_max_retries = 0", "stream_max_retries = 0", "",
    ].join("\n") });
    const model = "gpt-5.4";
    const result = await backend.run({ id: "model-rejected", caseId: "fixture", mode: "without_axiom",
      prompt: "Acknowledge the disposable model fixture.", workspace, timeoutMs: 12_000,
      host: { agent: "codex", version: supportedVersion, os: "linux", surface: "cli", model },
      policy: { version: "1", digest: `sha256:${"0".repeat(64)}`, profiles: [] },
    }, new AbortController().signal);
    expect(requestedModels).toEqual([model]);
    expect(result.outcome).toEqual({ status: "blocked", reason: "The native Codex provider rejected the requested model." });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result.artifacts).toHaveLength(1);
    expect(JSON.parse(await readFile(join(artifacts, result.artifacts[0]!.location), "utf8"))).toEqual({ actions: [] });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test.runIf(Boolean(executable) && process.platform === "linux")(
  "runs a paired native ChatGPT file profile against localhost with credential paths outside the tool sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "axiom-codex-native-auth-"));
    const loopback = await openLoopback("codex", "gpt-5.4");
    try {
      const workspace = join(root, "workspace");
      const authHome = join(root, "auth-profile");
      const archive = join(root, "archive");
      await Promise.all([mkdir(workspace), mkdir(authHome), mkdir(archive)]);
      const auth = join(authHome, "auth.json");
      const canary = "unrelated-profile-instruction";
      await writeFile(join(authHome, "AGENTS.md"), canary);
      const binary = await realpath(executable!);
      const shim = join(root, "native.fixture.cjs");
      // Only the fixture launcher redirects the pinned native CLI to localhost.
      const route = `model_providers.fixture={name="Fixture",base_url=${JSON.stringify(loopback.endpoint)},wire_api="responses",requires_openai_auth=true,request_max_retries=0,stream_max_retries=0}`;
      const helper = `permissions.axiom-benchmark.filesystem={":minimal"="read",":workspace_roots"="write",${JSON.stringify(binary)}="read"}`;
      await writeFile(shim, [
        "#!/usr/bin/env node",
        `const binary = ${JSON.stringify(binary)}, args = process.argv.slice(2);`,
        'const overrides = [];',
        `if (args.includes("sandbox") || args.includes("exec")) overrides.push("-c", ${JSON.stringify(helper)});`,
        `overrides.push("-c", 'model_provider="fixture"', "-c", ${JSON.stringify(route)});`,
        'const result = require("node:child_process").spawnSync(binary, [...overrides, ...args], { stdio: "inherit" });',
        'process.exit(result.status ?? 1);',
      ].join("\n"), { mode: 0o700 });
      const source = process.cwd();
      const core = { path: "core/AXIOMS.md", version: "1", text: await readFile(join(source, "core/AXIOMS.md"), "utf8") };
      const bundle = await buildCodexBundle({ source, destination: join(root, "bundle"), version: "0.1.0",
        catalog: { core, profiles: [], checks: {} }, profiles: [] });
      const host = { agent: "codex", version: supportedVersion, os: "linux", surface: "cli", model: "gpt-5.4" };
      const backend = createCodexBackend({ program: shim, artifacts: archive, bundle, authHome });
      const run = (mode: "with_axiom" | "without_axiom") => backend.run({
        id: mode, caseId: "fixture", prompt: "Acknowledge the file-profile fixture.", workspace, host,
        policy: bundle.policy, mode, timeoutMs: 24_000,
      }, new AbortController().signal);

      await writeFile(auth, JSON.stringify({ OPENAI_API_KEY: "not-a-real-api-key" }), { mode: 0o600 });
      expect(await run("without_axiom")).toMatchObject({ outcome: { status: "blocked", reason: expect.stringMatching(/ChatGPT/) } });
      expect(loopback.requests).toHaveLength(0);

      const jwt = [Buffer.from('{"typ":"JWT","alg":"none"}').toString("base64url"), Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", chatgpt_plan_type: "plus" },
      })).toString("base64url"), "fixture-signature"].join(".");
      const dummy = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
        tokens: { id_token: jwt, access_token: jwt, refresh_token: "fixture-only", account_id: "fixture-account" } });
      await writeFile(auth, dummy);
      const baseline = await run("without_axiom");
      expect(baseline, JSON.stringify({ outcome: baseline.outcome, requests: loopback.requests.length }))
        .toMatchObject({ outcome: { status: "passed" }, artifacts: [] });
      const installed = await run("with_axiom");
      expect(installed, JSON.stringify(installed.outcome)).toMatchObject({ outcome: { status: "passed" }, artifacts: [] });
      expect(loopback.requests.map(({ text }) => text.includes(bundle.policy.digest))).toEqual([false, true]);
      expect(loopback.requests.every(({ text }) => !text.includes(canary) && !text.includes(jwt))).toBe(true);
      expect(await readFile(auth, "utf8")).toBe(dummy);
    } finally {
      await loopback.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 55_000,
);

test.runIf(executable && process.platform === "linux")("uses the actual Codex CLI for local lifecycle and credential-free execution", async () => {
  const source = process.cwd();
  const identity = await snapshotSource({ root: source });
  const root = await mkdtemp(join(tmpdir(), "axiom-native-codex-"));
  const workspace = join(root, "workspace");
  const profile = { program: executable!, workspace, home: join(root, "profile"), userHome: join(root, "home") };
  const userText = "# User instructions\nPreserve my instruction.\n";
  const projectText = "# Project instructions\nKeep project instructions.\n";
  const userConfig = '# User setting\nmodel = "gpt-5.4"\n';
  const core = { path: "core/AXIOMS.md", version: "1", text: await readFile(join(source, "core/AXIOMS.md"), "utf8") };
  const catalog = { core, profiles: [], checks: {} };
  const host = { agent: "codex", version: supportedVersion, os: "linux", surface: "cli", model: "gpt-5.4" };
  const makeBundle = (version: string) => buildCodexBundle({
    source, destination: join(root, version), version, catalog, profiles: [],
  });
  try {
    await Promise.all([mkdir(workspace), mkdir(profile.home), mkdir(profile.userHome)]);
    await writeFile(join(profile.home, "config.toml"), userConfig);
    await writeFile(join(profile.home, "AGENTS.md"), userText);
    await writeFile(join(workspace, "AGENTS.md"), projectText);
    const first = await makeBundle("0.1.0");
    const later = await makeBundle("0.1.1");
    expect((await observeCodexProfile(profile)).discovered).toBe(false);

    await configureCodexProfile(profile, "install", first);
    await configureCodexProfile(profile, "install", first);
    const activated = await observeCodexProfile(profile);
    expect(activated).toMatchObject({ observedVersion: supportedVersion, discovered: true, selected: true });
    expect(activated.contexts).toEqual([first.instructions]);
    expect(activated.skills.toSorted()).toEqual(first.skills.map((name) => `axiom:${name}`).toSorted());

    await configureCodexProfile(profile, "disable");
    await configureCodexProfile(profile, "disable");
    const disabled = await observeCodexProfile(profile);
    expect(disabled).toMatchObject({ discovered: true, selected: false, skills: [] });
    expect(disabled.contexts.join("\n")).not.toContain(first.instructions);
    await configureCodexProfile(profile, "update", later);
    expect(await observeCodexProfile(profile)).toMatchObject({ discovered: true, selected: false });

    await configureCodexProfile(profile, "uninstall");
    await configureCodexProfile(profile, "uninstall");
    expect((await observeCodexProfile(profile)).discovered).toBe(false);
    expect(await readFile(join(profile.home, "AGENTS.md"), "utf8")).toBe(userText);
    expect(await readFile(join(profile.home, "config.toml"), "utf8")).toContain(userConfig);
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe(projectText);

    let requests = 0;
    let trial: {
      message: string;
      parentId?: string;
      childRequest: Promise<void>;
      finishChildRequest: (() => void) | undefined;
    } | undefined;
    const providerRequests: CodexProviderObservation[] = [];
    const server = createServer(async (incoming, outgoing) => {
      try {
        if (incoming.method === "GET") {
          outgoing.setHeader("Content-Type", "application/json");
          outgoing.end(JSON.stringify({ object: "list", data: [{ id: host.model, object: "model", owned_by: "fixture" }] }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        providerRequests.push({ turnMetadata: incoming.headers["x-codex-turn-metadata"], body });
        const metadata = JSON.parse(String(incoming.headers["x-codex-turn-metadata"] ?? "{}"));
        requests += 1;
        const id = `msg-fixture-${requests}`;
        let action: { name: string; call_id: string; arguments: string } | undefined;
        const currentTrial = trial;
        if (currentTrial && typeof metadata.thread_id === "string") {
          if (currentTrial.parentId === undefined && metadata.thread_source !== "subagent") {
            currentTrial.parentId = metadata.thread_id;
            action = {
              name: "spawn_agent", call_id: `call-worker-${requests}`,
              arguments: JSON.stringify({ message: currentTrial.message, fork_context: false }),
            };
          } else if (metadata.thread_id === currentTrial.parentId) {
            // Keep the parent alive until the real child's provider request is observed.
            const deadline = new AbortController();
            try {
              await Promise.race([
                currentTrial.childRequest,
                delay(6000, undefined, { signal: deadline.signal }).then(() => { throw new Error("No native child request."); }),
              ]);
            } finally {
              deadline.abort();
            }
          }
        }
        const message = action === undefined ? {
          id, type: "message", role: "assistant",
          content: [{ type: "output_text", text: "Fixture completed.", annotations: [] }], status: "completed",
        } : {
          id, type: "function_call", namespace: "multi_agent_v1", status: "completed", ...action,
        };
        const events = [
          { type: "response.created", response: { id } },
          { type: "response.output_item.added", item: message, output_index: 0 },
          { type: "response.output_item.done", item: message, output_index: 0 },
          { type: "response.completed", response: { id, status: "completed", usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
        ];
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
        if (currentTrial && metadata.thread_source === "subagent" && metadata.parent_thread_id === currentTrial.parentId) {
          currentTrial.finishChildRequest?.();
        }
      } catch { outgoing.writeHead(400).end(); }
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture provider address.");
      const configToml = [
        'model_provider = "fixture"', "[model_providers.fixture]", 'name = "Credential-free fixture"',
        `base_url = "http://127.0.0.1:${address.port}/v1"`, 'wire_api = "responses"', "requires_openai_auth = false",
        "request_max_retries = 0", "stream_max_retries = 0",
      ].join("\n");
      const backend = createCodexBackend({ program: profile.program, artifacts: join(root, "artifacts"), bundle: later, configToml });
      const result = await backend.run({
        id: "native-smoke", caseId: "fixture-case", workspace, prompt: "Respond with the fixture confirmation.",
        host, policy: later.policy, mode: "with_axiom", timeoutMs: 12_000,
      }, new AbortController().signal);
      expect(result).toMatchObject({
        outcome: { status: "passed" }, usage: { metering: "reported", inputTokens: 10, outputTokens: 3 },
        artifacts: [expect.objectContaining({ kind: "action-trace" })],
      });
      const trace = result.artifacts[0]!;
      expect(await new EvidenceStore(join(root, "artifacts")).artifact({ kind: trace.kind, path: trace.location })).toEqual(trace);
      expect(requests).toBe(1);

      await writeFile(join(profile.home, "config.toml"), configToml);
      await configureCodexProfile(profile, "install", later);
      const observation = await observeCodexProfile(profile);
      const brief: TaskBrief = {
        id: "native-worker", parentId: "native-parent", objective: "Inspect the fixture without editing.",
        ownedPaths: ["AGENTS.md"], policy: later.policy,
        criteria: [{ id: "read-only", description: "Leave all fixture files unchanged.", required: true }],
        requiredCapabilities: [], limits: { timeoutMs: 5000, maxAttempts: 1, maxConcurrency: 1 },
      };
      const delegate = async (message: string) => {
        providerRequests.length = 0;
        let finishChildRequest: (() => void) | undefined;
        const childRequest = new Promise<void>((resolve) => { finishChildRequest = resolve; });
        trial = { message, childRequest, finishChildRequest };
        const run = await runCodex(profile, [
          "--ask-for-approval", "never", "exec", "--sandbox", "read-only", "--ephemeral",
          "--skip-git-repo-check", "--color", "never", "--json", "--model", host.model, "-",
        ], { input: "Launch one read-only worker.", signal: AbortSignal.timeout(10_000) });
        expect(run.code).toBe(0);
        expect(parseCodexTrace(run.stdout).usage).toMatchObject({ metering: "unknown", reason: expect.stringMatching(/worker/i) });
        return assessCodexActivation({
          ...observation, bundle: later, host, catalog, observations: [], requiredCapabilities: ["delegation"],
          delegation: { brief, trace: run.stdout, requests: providerRequests },
        });
      };
      const complete = await delegate(formatCodexWorkerBrief(brief));
      expect(complete).toMatchObject({
        outcome: { status: "not_run" },
        delegation: { parentThreadId: expect.any(String), workerThreadId: expect.any(String), outcome: { status: "passed" } },
      });
      const omitted = await delegate(brief.objective);
      expect(omitted.outcome).toMatchObject({
        status: "failed", reason: expect.stringMatching(/omitted.*brief/i),
      });
      expect(await snapshotSource({ root: source })).toEqual(identity);
      process.stdout.write(JSON.stringify({
        kind: "native-codex-worker-loopback", source: identity, host, policy: later.policy,
        mechanism: "native exec JSONL linked to first provider request metadata and message layers",
        worker: complete.delegation, omittedBrief: omitted.delegation,
      }) + "\n");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((ready) => server.close(() => ready()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
