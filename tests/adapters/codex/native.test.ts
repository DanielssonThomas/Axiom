import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { TaskBrief } from "@axiom/contracts";
import {
  assessCodexActivation, buildCodexBundle, configureCodexProfile, createCodexBackend, formatCodexWorkerBrief,
  observeCodexProfile, parseCodexTrace, supportedVersion, type CodexProviderObservation,
} from "../../../adapters/codex/src/index.js";
import { runCodex } from "../../../adapters/codex/src/process.js";
import { EvidenceStore, snapshotSource } from "../../../packages/evidence/src/index.js";

const executable = process.env.AXIOM_TEST_CODEX_BINARY;

test.runIf(Boolean(executable))("uses the actual Codex CLI for local lifecycle and credential-free execution", async () => {
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
    let workerMessage: string | undefined;
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
        requests += 1;
        const id = `msg-fixture-${requests}`;
        const message = workerMessage === undefined ? {
          id, type: "message", role: "assistant",
          content: [{ type: "output_text", text: "Fixture completed.", annotations: [] }], status: "completed",
        } : {
          id, type: "function_call", namespace: "multi_agent_v1", name: "spawn_agent", status: "completed",
          call_id: `call-worker-${requests}`, arguments: JSON.stringify({ message: workerMessage, fork_context: false }),
        };
        workerMessage = undefined;
        const events = [
          { type: "response.created", response: { id } },
          { type: "response.output_item.added", item: message, output_index: 0 },
          { type: "response.output_item.done", item: message, output_index: 0 },
          { type: "response.completed", response: { id, status: "completed", usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
        ];
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
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
        workerMessage = message;
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
