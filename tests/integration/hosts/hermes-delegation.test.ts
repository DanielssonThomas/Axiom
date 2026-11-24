import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskBriefSchema } from "@axiom/contracts";
import { expect, test } from "vitest";
import {
  changeHermesPlugin, formatHermesWorkerContext, hermesBundleAdapter, inspectHermesActivation,
  inspectHermesWorkerDelivery, inspectHermesWorkerProfileRetrieval, hermesVersion,
} from "../../../adapters/hermes/src/index.js";
import { openHermesGateway, runHermes } from "../../../adapters/hermes/src/process.js";
import { assembleBundles, loadBundleWorkspace, writeBundles } from "../../../packages/bundles/src/index.js";
import { snapshotSource } from "../../../packages/evidence/src/index.js";
import { openLoopback } from "./loopback.js";

const executable = process.env.AXIOM_HERMES_CLI;
const skills = ["context", "delegate", "design", "diagnose", "knowledge", "verify"];

test.runIf(Boolean(executable) && process.platform === "linux").each(["core", "selected profiles"] as const)(
  "links native Hermes worker context and %s to the actual provider requests", async (scope) => {
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
      const profiled = scope === "selected profiles";
      const { catalog } = loadBundleWorkspace(process.cwd());
      const [artifact] = writeBundles(join(root, "bundles"), assembleBundles(process.cwd(), {
        version: "0.1.0", sourceRevision: source.revision ?? source.digest, policyVersion: catalog.core.version,
        selectedProfiles: profiled ? ["angular-nx"] : [], checks: catalog.checks,
        skills: skills.map((id) => ({ id })), adapters: [hermesBundleAdapter],
      }));
      if (!artifact) throw new Error("Expected the Hermes fixture artifact.");
      const profiles = await Promise.all(artifact.manifest.policy.profiles.map(async ({ id }) => ({
        id, name: `axiom:profile-${id}`, content: await readFile(join(process.cwd(), "profiles", id, "PROFILE.md"), "utf8"),
      })));
      expect(profiles.map(({ id }) => id)).toEqual(profiled ? ["angular-nx", "ui-atomic"] : []);
      const fixture = join(workspace, "fixture.txt");
      await writeFile(fixture, "This disposable fixture stays unchanged.\n");
      const brief = taskBriefSchema.parse({
        id: "fixture-worker", parentId: "fixture-parent", objective: "Inspect the worker-scope fixture without editing.",
        policy: artifact.manifest.policy, ownedPaths: ["fixture.txt"],
        criteria: [{ id: "read-only", description: "Leave the fixture unchanged.", required: true }],
        requiredCapabilities: [], limits: { timeoutMs: 5000, maxAttempts: 1, maxConcurrency: 1 },
      });
      const formatted = formatHermesWorkerContext(brief);
      const command = {
        executable: executable!, cwd: workspace, signal: AbortSignal.timeout(45_000), deadline: performance.now() + 45_000,
        env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: home, OPENAI_API_KEY: "loopback-only",
          HERMES_DISABLE_AUTO_UPDATE: "1", HERMES_DISABLE_LAZY_INSTALLS: "1" },
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
        const trials = ["present", "missing-brief", "provider-rejected",
          ...(profiled ? ["missing-profile", "retrieval-rejected"] : [])];
        const inspect = profiled ? inspectHermesWorkerProfileRetrieval : inspectHermesWorkerDelivery;
        for (const trial of trials) {
          loopback.requests.length = 0;
          const includeBrief = trial !== "missing-brief";
          const selectedProfiles = trial === "missing-profile" ? profiles.slice(0, 1) : profiles;
          const scheduleProfile = (index: number) => {
            const profile = selectedProfiles[index];
            if (profile) loopback.respondWithHermesTool(async () => {
              scheduleProfile(index + 1);
              return { name: "skill_view", arguments: JSON.stringify({ name: profile.name, file_path: "PROFILE.md" }) };
            });
            else if (trial === "retrieval-rejected") loopback.respondWithHermesTool(async () => {
              throw new Error("The disposable worker provider rejected the profile retrieval request.");
            });
          };
          loopback.respondWithHermesTool(async () => {
            if (trial === "provider-rejected") loopback.respondWithHermesTool(async () => {
              throw new Error("The disposable worker provider rejected the first request.");
            });
            else scheduleProfile(0);
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
          const rejected = trial === "provider-rejected" || trial === "retrieval-rejected";
          expect(delegation?.is_error).toBe(rejected);
          const workers = JSON.parse(delegation.output).results;
          const { subagent_id: workerId } = workers[0];
          const delivery = inspectHermesWorkerDelivery(target, terminal?.session_id, workerId, brief);
          const observed = inspect(target, terminal?.session_id, workerId, brief);
          if (trial === "provider-rejected") {
            expect(loopback.requests.some(({ text }) => text.includes(formatted))).toBe(true);
            expect(workers[0].status).not.toBe("completed");
            expect(observed).toMatchObject({ outcome: { status: "blocked", reason: expect.stringMatching(/no current/i) } });
            continue;
          }
          if (rejected) expect(workers[0].status).not.toBe("completed");
          else expect(workers).toEqual([expect.objectContaining({
            status: "completed", subagent_id: expect.any(String),
            tokens: { input: 9 * (selectedProfiles.length + 1), output: 3 * (selectedProfiles.length + 1) },
          })]);
          if (!rejected) expect(terminal?.tokens).toMatchObject({ input: 18, output: 6 });
          const receipt = await readFile(join(selected, ".axiom-hermes", `delegated-${workerId}.json`), "utf8");
          expect(receipt).not.toContain(brief.objective);
          expect(receipt).not.toContain(formatted);
          expect(JSON.parse(receipt).briefDigest).toBe(includeBrief ? hash(formatted) : null);
          const childRequests = loopback.requests.filter(({ text }) => text.includes(brief.objective) && !text.includes(parentPrompt));
          expect(childRequests).toHaveLength(selectedProfiles.length + 1);
          expect(childRequests[0]?.model).toBe(model);
          expect(childRequests[0]?.text).toContain(artifact.manifest.policy.digest);
          for (const skill of skills) expect(childRequests[0]?.text).toContain(`axiom:${skill}`);
          expect(childRequests[0]?.text.includes(formatted)).toBe(includeBrief);
          for (const profile of profiles) {
            expect(childRequests[0]?.text).toContain(profile.name);
            expect(childRequests[0]?.text.includes(profile.content.trimEnd())).toBe(false);
          }
          expect(childRequests.at(-1)!.toolResults.map((result) => JSON.parse(result))).toEqual(selectedProfiles.map((profile) =>
            expect.objectContaining({ name: profile.name, file: "PROFILE.md", success: true, content: profile.content }),
          ));
          if (profiled) expect(delivery.outcome).toMatchObject({ status: "blocked", reason: expect.stringMatching(/first.request/i) });
          const complete = includeBrief && trial !== "missing-profile" && !rejected;
          expect(observed).toMatchObject({ childSession: expect.any(String),
            outcome: { status: complete ? "passed" : "failed" } });
          const childSession = observed.childSession!;
          expect(childSession).not.toBe(terminal?.session_id);
          expect(inspect(target, "unrelated-parent", workerId, brief).outcome.status).toBe("blocked");
          expect(inspect(target, terminal?.session_id, workerId, { ...brief, ownedPaths: ["unrelated.txt"] }).outcome.status).toBe("failed");
          if (profiled) {
            const progressPath = join(selected, ".axiom-hermes", `delegated-profiles-${workerId}.json`);
            const contents = await readFile(progressPath, "utf8");
            const progress = JSON.parse(contents);
            expect(progress).toEqual({ digest: artifact.manifest.digest, instance: JSON.parse(receipt).instance,
              parentSession: terminal?.session_id, childSession, workerId, mechanism: "subsequent_llm_execution",
              profiles: (rejected ? selectedProfiles.slice(0, 1) : selectedProfiles).map(({ id, content }) => ({ id, digest: hash(content) })),
            });
            if (complete) {
              try {
                for (const mismatch of [{ childSession: "unrelated-child" }, { instance: "prior-installation" }]) {
                  await writeFile(progressPath, JSON.stringify({ ...progress, ...mismatch }));
                  expect(inspect(target, terminal?.session_id, workerId, brief).outcome).toMatchObject({
                    status: "blocked", reason: expect.stringMatching(/matched to the selected policy and native worker/i),
                  });
                }
              } finally {
                await writeFile(progressPath, contents);
              }
            }
          }
          expect(inspectHermesActivation(target, childSession)).toMatchObject({
            policy: artifact.manifest.policy, loaded: { status: trial === "missing-profile" ? "blocked" : "passed" },
          });
          expect(await readFile(fixture, "utf8")).toBe("This disposable fixture stays unchanged.\n");
          expect(await snapshotSource({ root: process.cwd() })).toEqual(source);
          process.stdout.write(JSON.stringify({
            kind: "native-hermes-worker-loopback", source, policy: artifact.manifest.policy, version: hermesVersion,
            host: { agent: "hermes", version: hermesVersion, model, os: process.platform, surface: "named-profile-cli" },
            profile: target.profile, bundleDigest: artifact.manifest.digest, trial,
            parentSession: terminal?.session_id, workerSession: childSession, worker: workers[0].subagent_id,
            expectedBriefDigest: hash(formatted), firstRequest: delivery.outcome, observed: observed.outcome,
            parentTokens: terminal?.tokens, workerTokens: workers[0].tokens,
            realModelBehavior: { status: "not_run", reason: "The native requests used a scripted localhost provider." },
            qualification: { status: "blocked", reason: "Production worker and real-model verification are required." },
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
        env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: home,
          HERMES_DISABLE_AUTO_UPDATE: "1", HERMES_DISABLE_LAZY_INSTALLS: "1" },
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
