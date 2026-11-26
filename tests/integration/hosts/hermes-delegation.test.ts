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
import { createProfileWorkspace, fixtureProfile } from "../../fixtures/profile-workspace.js";
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
      const repository = profiled ? createProfileWorkspace(process.cwd(), join(root, "source")) : process.cwd();
      const { catalog } = loadBundleWorkspace(repository);
      const [artifact] = writeBundles(join(root, "bundles"), assembleBundles(repository, {
        version: "0.1.0", sourceRevision: source.revision ?? source.digest, policyVersion: catalog.core.version,
        selectedProfiles: profiled ? [fixtureProfile] : [], checks: catalog.checks,
        skills: skills.map((id) => ({ id })), adapters: [hermesBundleAdapter],
      }));
      if (!artifact) throw new Error("Expected the Hermes fixture artifact.");
      const profiles = await Promise.all(artifact.manifest.policy.profiles.map(async ({ id }) => ({
        id, name: `axiom:profile-${id}`, content: await readFile(join(repository, "profiles", id, "PROFILE.md"), "utf8"),
      })));
      expect(profiles.map(({ id }) => id)).toEqual(profiled ? [fixtureProfile, "ui-atomic"] : []);
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
        executable: executable!, cwd: workspace, signal: AbortSignal.timeout(60_000), deadline: performance.now() + 60_000,
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
          ...(profiled ? ["inherited-read", "missing-profile", "retrieval-rejected"] : [])];
        const inspect = profiled ? inspectHermesWorkerProfileRetrieval : inspectHermesWorkerDelivery;
        for (const trial of trials) {
          loopback.requests.length = 0;
          const includeBrief = trial !== "missing-brief";
          const selectedProfiles = trial === "inherited-read" ? profiles.slice(0, 1)
            : trial === "missing-profile" ? profiles.slice(1)
            : trial === "retrieval-rejected" ? profiles.toReversed() : profiles;
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
          if (!profiled) {
            const launch = loopback.requests.find(({ userMessages }) => userMessages.includes(parentPrompt));
            expect(launch?.systemMessages.some((message) => message.includes(
              "Before calling delegate_task, read the authoritative task and open the axiom:delegate skill.",
            ))).toBe(true);
          }
          expect(childRequests[0]?.text.includes(formatted)).toBe(includeBrief);
          for (const profile of profiles) {
            expect(childRequests[0]?.text).toContain(profile.name);
            expect(childRequests[0]?.text.includes(profile.content.trimEnd())).toBe(false);
          }
          expect(childRequests.at(-1)!.toolResults.map((result) => JSON.parse(result))).toEqual(selectedProfiles.map((profile) =>
            expect.objectContaining({ name: profile.name, file: "PROFILE.md", success: true, content: profile.content }),
          ));
          if (trial === "inherited-read") {
            expect(JSON.parse(childRequests.at(-1)!.toolResults[0]!)).toMatchObject({
              inherited_profiles: [{ id: "ui-atomic", content: profiles[1]!.content }],
            });
          }
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
              profiles: (rejected ? selectedProfiles.slice(0, 1) : trial === "missing-profile" ? selectedProfiles : profiles)
                .map(({ id, content }) => ({ id, digest: hash(content) })),
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
      for (const alterInventory of profiled ? [false, true] : []) {
        const manifestPath = join(selected, "plugins", "axiom", "axiom-bundle.json");
        const manifestBytes = await readFile(manifestPath);
        const manifest = JSON.parse(manifestBytes.toString("utf8"));
        const definitions = await Promise.all(profiles.map(async ({ id }) => {
          const relative = `profiles/${id}/profile.json`;
          const path = join(selected, "plugins", "axiom", relative);
          return { id, path, relative, bytes: await readFile(path) };
        }));
        for (const { id, path, relative, bytes } of definitions) {
          const replacement = JSON.stringify({ ...JSON.parse(bytes.toString("utf8")), extends: id === "ui-atomic" ? [fixtureProfile] : [] });
          await writeFile(path, replacement);
          if (alterInventory) manifest.files.find((file: { path: string }) => file.path === relative).digest = hash(replacement);
        }
        if (alterInventory) await writeFile(manifestPath, JSON.stringify(manifest));
        const restore = () => Promise.all([
          ...definitions.map(({ path, bytes }) => writeFile(path, bytes)),
          writeFile(manifestPath, manifestBytes),
        ]);
        const restarted = await openHermesGateway({
          ...command, args: ["gateway", "run", "--no-supervise", "--external-supervisor"],
        }, home, target.profile);
        try {
          if ("interrupted" in restarted) throw new Error("The disposable Hermes restart did not begin.");
          loopback.requests.length = 0;
          loopback.respondWithHermesTool(async () => {
            // Restore valid bundle bytes after registration and before native tool dispatch.
            await restore();
            return { name: "skill_view", arguments: JSON.stringify({ name: profiles[1]!.name, file_path: "PROFILE.md" }) };
          });
          const result = await runHermes({
            ...command, signal: AbortSignal.any([command.signal, restarted.signal]), input: "Inspect the disposable profile.",
            args: ["--profile", target.profile, "chat", "--query-file", "-", "--format", "stream-json",
              "--model", model, "--provider", "custom", "--max-turns", "2", "--base-url", loopback.endpoint + "/v1"],
          });
          expect(result.code).toBe(0);
          const attached = loopback.requests.flatMap(({ toolResults }) => toolResults.map((raw) => JSON.parse(raw)))
            .some((result) => result.inherited_profiles?.some(({ id }: { id: string }) => id === fixtureProfile));
          expect(attached, `changed inventory: ${alterInventory}`).toBe(false);
          const terminal = result.stdout.trim().split("\n").map((line) => JSON.parse(line)).find(({ type }) => type === "result");
          expect(terminal?.session_id).toBeTruthy();
          expect(inspectHermesActivation(target, terminal.session_id).loaded.status).toBe("not_run");
          expect(loopback.requests[0]?.systemMessages.some((message) => message.includes(artifact.manifest.policy.digest))).toBe(false);
        } finally {
          if ("stop" in restarted) await restarted.stop();
          await restore();
        }
      }
    } finally {
      await loopback.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 70_000,
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
