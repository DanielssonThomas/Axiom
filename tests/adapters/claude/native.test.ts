import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  assessClaudeActivation, buildClaudeBundle, configureClaudeProfile, createClaudeBackend, executeClaudeSession,
  observeClaudeInstallation, supportedVersion, validateClaudeBundle, workerBriefEnvironment,
} from "../../../adapters/claude/src/index.js";
import { EvidenceStore } from "../../../packages/evidence/src/index.js";

const executable = process.env.AXIOM_TEST_CLAUDE_BINARY;
const host = { agent: "claude", version: supportedVersion, model: "claude-sonnet-4-6", os: "linux", surface: "cli" };

test.runIf(Boolean(executable))("validates and exercises the installed Claude plugin and real benchmark CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "axiom-claude-native-"));
  const workspace = join(root, "workspace");
  const home = join(root, "claude");
  const userHome = join(root, "user");
  const userSettings = { env: { AXIOM_UNRELATED_USER: "preserved" } };
  const localSettings = { env: { AXIOM_UNRELATED_LOCAL: "preserved" } };
  const projectInstructions = "# Project instructions\nPreserve these bytes.\n";
  let received = 0;
  let sawDigest = false;
  let sawSkills = false;
  let offerDelegation = false;
  let sawWorkerBrief = false;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      received += 1;
      sawDigest = body.includes("Axiom policy digest: sha256:");
      sawSkills = body.includes("axiom:context");
      sawWorkerBrief ||= body.includes("Axiom scoped worker brief:") && body.includes("worker-native");
      const sendDelegate = offerDelegation;
      offerDelegation = false;
      const toolInput = {
        description: "Verify fixture", subagent_type: "general-purpose", prompt: "Confirm the worker fixture.",
      };
      const tool = { type: "tool_use", id: "toolu_fixture", name: "Task", input: {} };
      const stream = [
        { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [],
          model: host.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: sendDelegate ? tool : { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: sendDelegate ?
          { type: "input_json_delta", partial_json: JSON.stringify(toolInput) } : { type: "text_delta", text: "Fixture complete." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: sendDelegate ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ];
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(stream.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  try {
    await Promise.all([mkdir(join(workspace, ".claude"), { recursive: true }), mkdir(home), mkdir(userHome)]);
    execFileSync("git", ["init", "--quiet", workspace]);
    await writeFile(join(home, "settings.json"), JSON.stringify(userSettings));
    await writeFile(join(workspace, ".claude/settings.local.json"), JSON.stringify(localSettings));
    await writeFile(join(workspace, "CLAUDE.md"), projectInstructions);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local fixture provider address.");
    const environment = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_AUTH_TOKEN: "fixture-no-credentials" };
    const profile = { program: executable!, home, userHome, workspace, environment };
    const makeBundle = (version: string) => buildClaudeBundle({
      repository: process.cwd(), destination: join(root, "bundles"), sourceRevision: "native-fixture",
      policyVersion: "1", selectedProfiles: [], checks: {}, version,
      skills: ["context", "delegate", "design", "diagnose", "knowledge", "verify"].map((id) => ({ id })),
    });
    const first = await makeBundle("1.0.0");
    const updated = await makeBundle("1.0.1");
    expect(await validateClaudeBundle(profile, first)).toEqual(expect.arrayContaining(first.manifest.skills.map(({ id }) => `axiom:${id}`)));
    expect((await observeClaudeInstallation(profile, "local")).discovered).toBe(false);
    await configureClaudeProfile(profile, "local", "install", first);
    await configureClaudeProfile(profile, "local", "install", first);
    expect(await observeClaudeInstallation(profile, "local")).toMatchObject({ discovered: true, selected: true });

    const options = { prompt: "Confirm the fixture.", model: host.model, maxBudgetUsd: 0.1 };
    const started = await executeClaudeSession(profile, options);
    expect(started.outcome.status).toBe("passed");
    expect(assessClaudeActivation(first, host, started.observation).outcome.status).toBe("passed");
    expect(sawDigest && sawSkills).toBe(true);

    await configureClaudeProfile(profile, "local", "disable");
    await configureClaudeProfile(profile, "local", "disable");
    await configureClaudeProfile(profile, "local", "update", updated);
    await configureClaudeProfile(profile, "local", "update", updated);
    expect(await observeClaudeInstallation(profile, "local")).toMatchObject({ discovered: true, selected: false });
    const disabled = await executeClaudeSession(profile, options);
    expect(disabled.observation.policyDigests).toEqual([]);
    expect(assessClaudeActivation(updated, host, disabled.observation).outcome.status).toBe("blocked");

    await configureClaudeProfile(profile, "local", "uninstall");
    await configureClaudeProfile(profile, "local", "uninstall");
    expect((await observeClaudeInstallation(profile, "local")).discovered).toBe(false);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toMatchObject(userSettings);
    expect(JSON.parse(await readFile(join(workspace, ".claude/settings.local.json"), "utf8"))).toMatchObject(localSettings);
    expect(await readFile(join(workspace, "CLAUDE.md"), "utf8")).toBe(projectInstructions);

    const artifacts = join(root, "archive");
    const backend = createClaudeBackend({ program: profile.program, environment, artifacts, bundle: updated, maxBudgetUsd: 0.1 });
    const request = {
      id: "native-fixture", caseId: "fixture", prompt: options.prompt, workspace, host, policy: updated.manifest.policy,
      mode: "with_axiom" as const, timeoutMs: 8000,
    };
    const result = await backend.run(request, new AbortController().signal);
    expect(result).toMatchObject({ outcome: { status: "passed" }, usage: { metering: "reported", inputTokens: 9, outputTokens: 3 } });
    const trace = result.artifacts[0]!;
    expect(await new EvidenceStore(artifacts).artifact({ kind: trace.kind, path: trace.location })).toEqual(trace);
    expect(sawDigest && sawSkills).toBe(true);

    const damagedFile = join(updated.plugin, "skills/context/SKILL.md");
    await writeFile(damagedFile, (await readFile(damagedFile, "utf8")) + "\nFixture integrity failure.\n");
    const invalid = await backend.run({ ...request, id: "failed-hook" }, new AbortController().signal);
    expect(invalid.outcome).toMatchObject({ status: "blocked", reason: expect.stringMatching(/context loading/i) });
    expect(sawDigest).toBe(false);
    expect(received).toBe(4);

    offerDelegation = true;
    const worker = workerBriefEnvironment({
      id: "worker-native", parentId: "parent-native", objective: "Confirm the worker fixture.",
      ownedPaths: ["fixture"], policy: first.manifest.policy,
      criteria: [{ id: "worker-check", description: "Confirm worker context.", required: true }],
      requiredCapabilities: [], limits: { timeoutMs: 1000, maxAttempts: 1, maxConcurrency: 1 },
    });
    const delegated = await executeClaudeSession({ ...profile, environment: { ...environment, ...worker } }, {
      ...options, bundle: first, prompt: "Create one fixture worker.",
    });
    expect(delegated.observation.observedWorkerIds).toContain("worker-native");
    expect(assessClaudeActivation(first, host, delegated.observation, ["delegation"]).outcome.status).toBe("passed");
    expect(sawWorkerBrief).toBe(true);

    const foreignHome = join(root, "other-marketplace-profile");
    await mkdir(foreignHome);
    const foreign = { ...profile, home: foreignHome };
    const scopedEnvironment = { PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: foreignHome };
    execFileSync(profile.program, ["plugin", "marketplace", "add", first.directory, "--json"], {
      cwd: workspace, env: scopedEnvironment, timeout: 5000,
    });
    execFileSync(profile.program, ["plugin", "install", "axiom@axiom-local", "--scope", "user", "--json"], {
      cwd: workspace, env: scopedEnvironment, timeout: 5000,
    });
    await expect(configureClaudeProfile(foreign, "user", "uninstall")).rejects.toThrow(/different source/i);
    expect((await observeClaudeInstallation(foreign, "user")).selected).toBe(true);
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((ready) => server.close(() => ready()));
    }
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
