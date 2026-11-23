import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  buildCodexBundle, configureCodexProfile, createCodexBackend, observeCodexProfile, supportedVersion,
} from "../../../adapters/codex/src/index.js";
import { EvidenceStore } from "../../../packages/evidence/src/index.js";

const executable = process.env.AXIOM_TEST_CODEX_BINARY;

test.runIf(Boolean(executable))("uses the actual Codex CLI for local lifecycle and credential-free execution", async () => {
  const source = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "axiom-native-codex-"));
  const workspace = join(root, "workspace");
  const profile = { program: executable!, workspace, home: join(root, "profile"), userHome: join(root, "home") };
  const userText = "# User instructions\nPreserve my instruction.\n";
  const projectText = "# Project instructions\nKeep project instructions.\n";
  const userConfig = '# User setting\nmodel = "gpt-5.4"\n';
  const core = { path: "core/AXIOMS.md", version: "1", text: await readFile(join(source, "core/AXIOMS.md"), "utf8") };
  const makeBundle = (version: string) => buildCodexBundle({
    source, destination: join(root, version), version, catalog: { core, profiles: [], checks: {} }, profiles: [],
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
    const server = createServer((incoming, outgoing) => {
      incoming.resume();
      incoming.once("end", () => {
        requests += 1;
        const message = {
          id: "msg-fixture", type: "message", role: "assistant",
          content: [{ type: "output_text", text: "Fixture completed.", annotations: [] }], status: "completed",
        };
        const events = [
          { type: "response.created", response: { id: "resp-fixture" } },
          { type: "response.output_item.added", item: { ...message, content: [], status: "in_progress" } },
          { type: "response.output_text.delta", delta: "Fixture completed.", item_id: message.id, output_index: 0, content_index: 0 },
          { type: "response.output_item.done", item: message },
          { type: "response.completed", response: { id: "resp-fixture", status: "completed", usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
        ];
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      });
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
        host: { agent: "codex", version: supportedVersion, os: "linux", surface: "cli", model: "gpt-5.4" },
        policy: later.policy, mode: "with_axiom", timeoutMs: 12_000,
      }, new AbortController().signal);
      expect(result).toMatchObject({
        outcome: { status: "passed" }, usage: { metering: "reported", inputTokens: 10, outputTokens: 3 },
        artifacts: [expect.objectContaining({ kind: "action-trace" })],
      });
      const trace = result.artifacts[0]!;
      expect(await new EvidenceStore(join(root, "artifacts")).artifact({ kind: trace.kind, path: trace.location })).toEqual(trace);
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((ready) => server.close(() => ready()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
