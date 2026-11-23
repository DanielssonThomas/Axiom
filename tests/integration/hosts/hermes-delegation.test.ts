import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskBriefSchema } from "@axiom/contracts";
import { expect, test } from "vitest";
import { changeHermesPlugin, hermesBundleAdapter, inspectHermesActivation, hermesVersion } from "../../../adapters/hermes/src/index.js";
import { openHermesGateway, runHermes } from "../../../adapters/hermes/src/process.js";
import { assembleBundles, writeBundles } from "../../../packages/bundles/src/index.js";
import { snapshotSource } from "../../../packages/evidence/src/index.js";
import { openLoopback } from "./loopback.js";

const executable = process.env.AXIOM_HERMES_CLI;
const skills = ["context", "delegate", "design", "diagnose", "knowledge", "verify"];

function observerSource(brief: string) {
  return `
import json
from pathlib import Path
from hermes_constants import get_hermes_home

def record(event):
    with (Path(get_hermes_home()) / "delegation-fixture.jsonl").open("a") as out:
        out.write(json.dumps(event) + "\\n")

def start(parent_session_id=None, child_session_id=None, child_subagent_id=None, **kwargs):
    record({"kind": "start", "parent": parent_session_id, "child": child_session_id, "worker": child_subagent_id})

def request(request, session_id=None, **kwargs):
    messages = request.get("messages", [])
    record({"kind": "request", "session": session_id, "brief": any(
        ${JSON.stringify(brief)} in message["content"] for message in messages
        if message.get("role") == "user" and isinstance(message.get("content"), str)
    )})

def register(ctx):
    ctx.register_hook("subagent_start", start)
    ctx.register_middleware("llm_request", request)
`;
}

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
      const formatted = "Axiom scoped worker brief:\n" + JSON.stringify(brief);
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
      const observer = join(selected, "plugins", "delegation-fixture");
      await mkdir(observer);
      await writeFile(join(observer, "plugin.yaml"), "name: delegation-fixture\nversion: 0.0.0\ndescription: Fixture observer.\n");
      await writeFile(join(observer, "__init__.py"), observerSource(formatted));
      await writeFile(join(selected, "config.yaml"), "plugins:\n  enabled: [axiom, delegation-fixture]\n");

      const gateway = await openHermesGateway({
        ...command, args: ["gateway", "run", "--no-supervise", "--external-supervisor"],
      }, home, target.profile);
      if ("interrupted" in gateway) throw new Error("The disposable native Hermes gateway did not start.");
      try {
        for (const includeBrief of [true, false]) {
          const observations = join(selected, "delegation-fixture.jsonl");
          await rm(observations, { force: true });
          loopback.requests.length = 0;
          loopback.respondWithHermesTool(async () => ({
            name: "delegate_task",
            arguments: JSON.stringify({ tasks: [{ goal: brief.objective, ...(includeBrief && { context: formatted }) }] }),
          }));
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
          expect(delegation?.is_error).toBe(false);
          const workers = JSON.parse(delegation.output).results;
          expect(workers).toEqual([expect.objectContaining({
            status: "completed", subagent_id: expect.any(String), tokens: { input: 9, output: 3 },
          })]);
          expect(terminal?.tokens).toMatchObject({ input: 18, output: 6 });
          const records = (await readFile(observations, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
          const starts = records.filter((event) => event.kind === "start");
          expect(starts).toEqual([expect.objectContaining({
            parent: terminal?.session_id, child: expect.any(String), worker: workers[0].subagent_id,
          })]);
          const childSession: string = starts[0].child;
          expect(childSession).not.toBe(terminal?.session_id);
          expect(records.find((event) => event.kind === "request" && event.session === childSession)?.brief).toBe(includeBrief);
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
