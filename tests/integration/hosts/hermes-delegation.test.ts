import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskBriefSchema } from "@axiom/contracts";
import { expect, test } from "vitest";
import {
  changeHermesPlugin, formatHermesWorkerContext, hermesBundleAdapter, inspectHermesActivation,
  inspectHermesWorkerDelivery, hermesVersion,
} from "../../../adapters/hermes/src/index.js";
import { openHermesGateway, runHermes } from "../../../adapters/hermes/src/process.js";
import { assembleBundles, writeBundles } from "../../../packages/bundles/src/index.js";
import { snapshotSource } from "../../../packages/evidence/src/index.js";
import { openLoopback } from "./loopback.js";

const executable = process.env.AXIOM_HERMES_CLI;
const skills = ["context", "delegate", "design", "diagnose", "knowledge", "verify"];

test.runIf(Boolean(executable) && process.platform === "linux")(
  "links native Hermes worker context to the actual model request and detects an omitted brief", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-hermes-worker-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const model = "fixture-model";
    const loopback = await openLoopback("hermes", model);
    const hash = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
    try {
      await mkdir(workspace);
      const target = { home, profile: "qualification" };
      const source = await snapshotSource({ root: process.cwd() });
      const [artifact] = writeBundles(join(root, "bundles"), assembleBundles(process.cwd(), {
        version: "0.1.0", sourceRevision: source.revision ?? source.digest, policyVersion: "1", selectedProfiles: [],
        checks: {}, skills: skills.map((id) => ({ id })), adapters: [hermesBundleAdapter],
      }));
      if (!artifact) throw new Error("Expected the Hermes fixture artifact.");
      const brief = taskBriefSchema.parse({
        id: "fixture-worker", parentId: "fixture-parent", objective: "Inspect the worker-scope fixture without editing.",
        policy: artifact.manifest.policy, ownedPaths: ["fixture.txt"],
        criteria: [{ id: "read-only", description: "Leave the fixture unchanged.", required: true }],
        requiredCapabilities: [], limits: { timeoutMs: 5000, maxAttempts: 1, maxConcurrency: 1 },
      });
      const formatted = formatHermesWorkerContext(brief);
      const command = {
        executable: executable!, cwd: workspace, signal: AbortSignal.timeout(45_000), deadline: performance.now() + 45_000,
        env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: home,
          OPENAI_API_KEY: "loopback-only", HERMES_DISABLE_AUTO_UPDATE: "1" },
      };
      const version = await runHermes({ ...command, args: ["--version"] });
      expect(version).toMatchObject({ code: 0, stdout: expect.stringContaining(`Hermes Agent v${hermesVersion}`) });
      expect((await runHermes({ ...command, args: ["profile", "create", target.profile, "--no-alias", "--no-credentials"] })).code).toBe(0);
      expect(changeHermesPlugin(target, { kind: "install", bundle: artifact.directory }).outcome).toEqual({ status: "passed" });
      const selected = join(home, "profiles", target.profile);

      const gateway = await openHermesGateway({
        ...command, args: ["gateway", "run", "--no-supervise", "--external-supervisor"],
      }, home, target.profile);
      if ("interrupted" in gateway) throw new Error("The disposable native Hermes gateway did not start.");
      try {
        for (const trial of ["present", "missing", "provider-rejected"] as const) {
          loopback.requests.length = 0;
          const includeBrief = trial !== "missing";
          loopback.respondWithHermesTool(async () => {
            if (trial === "provider-rejected") loopback.respondWithHermesTool(async () => {
              throw new Error("The disposable worker provider rejected the first request.");
            });
            return { name: "delegate_task",
              arguments: JSON.stringify({ tasks: [{ goal: brief.objective, ...(includeBrief && { context: formatted }) }] }) };
          });
          const parentPrompt = "Launch a single read-only fixture worker.";
          const result = await runHermes({
            ...command, signal: AbortSignal.any([command.signal, gateway.signal]), input: parentPrompt,
            args: ["--profile", target.profile, "chat", "--query-file", "-", "--format", "stream-json",
              "--model", model, "--provider", "custom", "--max-turns", "3", "--base-url", loopback.endpoint + "/v1"],
          });
          expect(result.code).toBe(0);
          const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
          const terminal = events.find((event) => event.type === "result");
          const delegation = events.find((event) => event.type === "tool_result" && event.name === "delegate_task");
          expect(delegation?.is_error).toBe(trial === "provider-rejected");
          const workers = JSON.parse(delegation.output).results;
          const { subagent_id: workerId } = workers[0];
          const delivery = inspectHermesWorkerDelivery(target, terminal?.session_id, workerId, brief);
          if (trial === "provider-rejected") {
            expect(loopback.requests.some(({ text }) => text.includes(formatted))).toBe(true);
            expect(workers[0].status).not.toBe("completed");
            expect(delivery.outcome.status).toBe("blocked");
            continue;
          }
          expect(workers).toEqual([expect.objectContaining({
            status: "completed", subagent_id: expect.any(String), tokens: { input: 9, output: 3 },
          })]);
          expect(terminal?.tokens).toMatchObject({ input: 18, output: 6 });
          expect(delivery).toMatchObject({
            childSession: expect.any(String),
            outcome: { status: includeBrief ? "passed" : "failed" },
          });
          const childSession = delivery.childSession!;
          expect(childSession).not.toBe(terminal?.session_id);
          expect(inspectHermesWorkerDelivery(target, "unrelated-parent", workerId, brief).outcome.status).toBe("blocked");
          expect(inspectHermesWorkerDelivery(target, terminal?.session_id, workerId, {
            ...brief, ownedPaths: ["unrelated.txt"],
          }).outcome.status).toBe("failed");
          const receipt = await readFile(join(selected, ".axiom-hermes", `delegated-${workerId}.json`), "utf8");
          expect(receipt).not.toContain(brief.objective);
          expect(receipt).not.toContain(formatted);
          expect(JSON.parse(receipt).briefDigest).toBe(includeBrief ? hash(formatted) : null);
          expect(inspectHermesActivation(target, childSession)).toMatchObject({
            policy: artifact.manifest.policy, loaded: { status: "passed" },
          });
          const childRequests = loopback.requests.filter(({ text }) => text.includes(brief.objective) && !text.includes(parentPrompt));
          expect(childRequests).toHaveLength(1);
          expect(childRequests[0]?.model).toBe(model);
          expect(childRequests[0]?.text).toContain(artifact.manifest.policy.digest);
          for (const skill of skills) expect(childRequests[0]?.text).toContain(`axiom:${skill}`);
          expect(childRequests[0]?.text.includes(formatted)).toBe(includeBrief);
          expect(await snapshotSource({ root: process.cwd() })).toEqual(source);
          process.stdout.write(JSON.stringify({
            kind: "native-hermes-worker-loopback", source, policy: artifact.manifest.policy, version: hermesVersion,
            parentSession: terminal?.session_id, workerSession: childSession, worker: workers[0].subagent_id,
            expectedBriefDigest: hash(formatted), observed: includeBrief ? "present" : "missing",
            parentTokens: terminal?.tokens, workerTokens: workers[0].tokens,
          }) + "\n");
        }
      } finally {
        await gateway.stop();
      }
    } finally {
      await loopback.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 55_000,
);

test.runIf(Boolean(executable) && process.platform === "linux")(
  "observes complete core in the native Hermes Responses route", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-hermes-responses-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const target = { home, profile: "qualification" };
    const model = "gpt-5.4";
    const loopback = await openLoopback("codex", model);
    try {
      await mkdir(workspace);
      const source = await snapshotSource({ root: process.cwd() });
      const [artifact] = writeBundles(join(root, "bundles"), assembleBundles(process.cwd(), {
        version: "0.1.0", sourceRevision: source.revision ?? source.digest, policyVersion: "1", selectedProfiles: [],
        checks: {}, skills: skills.map((id) => ({ id })), adapters: [hermesBundleAdapter],
      }));
      if (!artifact) throw new Error("Expected the Hermes fixture artifact.");
      const command = {
        executable: executable!, cwd: workspace, signal: AbortSignal.timeout(35_000), deadline: performance.now() + 35_000,
        env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: home, HERMES_DISABLE_AUTO_UPDATE: "1" },
      };
      expect((await runHermes({ ...command, args: ["profile", "create", target.profile, "--no-alias", "--no-credentials"] })).code).toBe(0);
      expect(changeHermesPlugin(target, { kind: "install", bundle: artifact.directory }).outcome).toEqual({ status: "passed" });
      const config = join(home, "profiles", target.profile, "config.yaml");
      await writeFile(config, `plugins:\n  enabled: [axiom]\nmodel:\n  provider: custom:loopback\n  default: ${model}\nproviders:\n  loopback:\n    api: ${loopback.endpoint}/v1\n    api_key: benchmark-loopback-dummy\n    transport: codex_responses\n    discover_models: false\n    context_length: 65536\n`);
      const gateway = await openHermesGateway({
        ...command, args: ["gateway", "run", "--no-supervise", "--external-supervisor"],
      }, home, target.profile);
      if ("interrupted" in gateway) throw new Error("The disposable native Hermes gateway did not start.");
      try {
        const result = await runHermes({
          ...command, signal: AbortSignal.any([command.signal, gateway.signal]), input: "Acknowledge the disposable session.",
          args: ["--profile", target.profile, "chat", "--query-file", "-", "--format", "stream-json",
            "--model", model, "--provider", "custom:loopback", "--max-turns", "2"],
        });
        expect(result.code, JSON.stringify(result)).toBe(0);
        const terminal = result.stdout.trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "result");
        expect(loopback.requests[0]?.text).toContain(artifact.manifest.policy.digest);
        expect(inspectHermesActivation(target, terminal?.session_id)).toMatchObject({
          policy: artifact.manifest.policy, coreLoaded: { status: "passed" }, loaded: { status: "passed" },
        });
        expect(await snapshotSource({ root: process.cwd() })).toEqual(source);
      } finally {
        await gateway.stop();
      }
    } finally {
      await loopback.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000,
);
