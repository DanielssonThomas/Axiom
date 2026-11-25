import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { evaluationCaseSchema } from "@axiom/contracts";
import { expect, test } from "vitest";
import { changeHermesPlugin, hermesBundleAdapter, hermesVersion, inspectHermesActivation } from "../../../adapters/hermes/src/index.js";
import { openHermesGateway, runHermes } from "../../../adapters/hermes/src/process.js";
import { localHermesPort } from "../../../adapters/hermes/src/clarification.js";
import { gradeCase } from "../../../evals/graders/index.js";
import { assembleBundles, loadBundleWorkspace, writeBundles } from "../../../packages/bundles/src/index.js";
import { snapshotSource } from "../../../packages/evidence/src/index.js";
import { openLoopback } from "./loopback.js";

const executable = process.env.AXIOM_HERMES_CLI;
const profile = "qualification-clarify";
const model = "fixture-model";
const question = "Which target audience should receive the new summary output?";
const projectedQuestion = `${question}\nReply "skip" to skip this question.`;
const choices = ["Operations dashboard", "Console operators"];
const fixtureFiles = ["issue.txt", "summary.mjs"];

interface PendingClarification {
  kind: string;
  prompt_id: string;
  execution_generation: number;
  question: string;
  choices: string[];
}
interface RunState {
  run_id: string;
  session_id: string;
  admission_id: string;
  execution_generation: number;
  status: string;
  pending_controls: PendingClarification[];
}
interface RunEvent extends Partial<PendingClarification> {
  event: string;
  seq: number;
  run_id: string;
  tool?: string;
  tool_call_id?: string;
  error?: boolean;
}

async function poll<T>(sample: () => Promise<T | undefined>, reason: string, signal: AbortSignal): Promise<T> {
  const until = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  try {
    while (!until.aborted) {
      const value = await sample();
      if (value !== undefined) return value;
      await delay(50, undefined, { signal: until });
    }
  } catch (error) {
    if (!until.aborted) throw error;
  }
  throw new Error(reason);
}

async function snapshotFixture(workspace: string) {
  expect((await readdir(workspace)).sort()).toEqual(fixtureFiles);
  return new Map(await Promise.all(fixtureFiles.map(async (file) => [file, await readFile(join(workspace, file), "utf8")] as const)));
}

test.runIf(executable && process.platform === "linux")(
  "installed Hermes gateway waits for the exact native clarification control before resuming", async () => {
    const source = process.cwd();
    const casePath = "skills/context/evals/clarify-material-decision.json";
    const evaluation = evaluationCaseSchema.parse(JSON.parse(await readFile(join(source, casePath), "utf8")));
    const revision = await snapshotSource({ root: source });
    const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-hermes-gateway-clarify-")));
    const home = join(root, "home");
    const workspace = join(root, "fixture");
    const selected = join(home, "profiles", profile);
    const target = { home, profile };
    const signal = AbortSignal.timeout(85_000);
    const port = await localHermesPort();
    const token = randomUUID();
    const loopback = await openLoopback("hermes", model, ({ text, toolResults }) => {
      if (!text.includes(evaluation.prompt)) return;
      if (toolResults.length === 0) return { name: "read_file", arguments: JSON.stringify({ path: join(workspace, "issue.txt") }) };
      if (toolResults.length === 1) return { name: "clarify", arguments: JSON.stringify({ questions: [{ question, choices }] }) };
    });
    const env = {
      PATH: process.env.PATH, HOME: home, HERMES_HOME: home, HERMES_TUI_GATEWAY_URL: "",
      HERMES_NO_SYSTEMD: "1", HERMES_DISABLE_LAZY_INSTALLS: "1", HERMES_DISABLE_AUTO_UPDATE: "1",
      OPENAI_API_KEY: "loopback-only", API_SERVER_ENABLED: "true", API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: String(port), API_SERVER_KEY: token, AXIOM_HERMES_NODE: process.execPath,
    };
    const native = { executable: executable!, cwd: workspace, env, deadline: performance.now() + 80_000, signal };
    const origin = `http://127.0.0.1:${port}`;
    const request = (path: string, body?: unknown, authenticated = true) => fetch(origin + path, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    let stop: (() => Promise<void>) | undefined;
    try {
      await Promise.all([mkdir(home), cp(join(source, evaluation.fixture), workspace, { recursive: true })]);
      const before = await snapshotFixture(workspace);
      expect((await runHermes({ ...native, args: ["profile", "create", profile, "--no-alias", "--no-credentials", "--no-skills"] })).code).toBe(0);
      expect((await runHermes({ ...native, args: ["--profile", profile, "--version"] })).stdout).toContain(`Hermes Agent v${hermesVersion}`);
      await writeFile(join(selected, "config.yaml"), JSON.stringify({
        gateway: { standalone: true },
        model: { default: model, provider: "custom", base_url: `${loopback.endpoint}/v1`, context_length: 128000 },
        platform_toolsets: { api_server: ["file", "clarify"] },
        auxiliary: { title_generation: { enabled: false } },
        updates: { check: false }, kanban: { dispatch_in_gateway: false },
      }));
      const { catalog, skills } = loadBundleWorkspace(source);
      const [bundle] = writeBundles(join(root, "bundles"), assembleBundles(source, {
        version: "0.1.0", sourceRevision: revision.revision ?? revision.digest, policyVersion: catalog.core.version,
        selectedProfiles: [], checks: catalog.checks, skills, adapters: [hermesBundleAdapter],
      }));
      expect(changeHermesPlugin(target, { kind: "install", bundle: bundle!.directory }).outcome).toEqual({ status: "passed" });
      expect(inspectHermesActivation(target)).toMatchObject({ enabled: true, bundleDigest: bundle!.manifest.digest });
      const gateway = await openHermesGateway({ ...native, args: ["--profile", profile,
        "gateway", "run", "--no-supervise", "--external-supervisor"] }, selected, profile, true);
      if ("interrupted" in gateway) throw new Error(`The disposable Hermes gateway did not start (${gateway.interrupted}).`);
      stop = gateway.stop;
      await poll(async () => {
        const response = await request("/v1/capabilities").catch(() => undefined);
        return response?.ok ? true : undefined;
      }, "The Hermes Runs API was unavailable.", signal);
      expect((await request("/v1/capabilities", undefined, false)).status).toBe(401);

      const sessionId = "axiom-clarification-fixture";
      const submitted = await request("/v1/runs", { session_id: sessionId, input: evaluation.prompt });
      expect(submitted.status).toBe(202);
      const { run_id: runId } = await submitted.json() as { run_id: string };
      expect(runId).toMatch(/^run_[a-f0-9]+$/);
      const route = `/v1/runs/${runId}`;
      const status = async () => {
        const response = await request(route);
        expect(response.status).toBe(200);
        return await response.json() as RunState;
      };
      const waiting = await poll(async () => {
        const state = await status();
        if (["completed", "failed", "cancelled"].includes(state.status)) {
          throw new Error("The native run ended before exposing a pending clarification.");
        }
        return state.pending_controls?.length ? state : undefined;
      }, "Hermes did not publish a pending clarification.", signal);
      expect(waiting).toMatchObject({ run_id: runId, session_id: sessionId, status: "running" });
      expect(waiting.admission_id).toMatch(/^[a-f0-9]+$/);
      expect(waiting.pending_controls).toEqual([{ kind: "clarify", prompt_id: expect.stringMatching(/^[a-f0-9]+$/),
        execution_generation: waiting.execution_generation, question: projectedQuestion,
        choices: ["Operations dashboard (Recommended)", "Console operators"], multi_select: false }]);
      const prompt = waiting.pending_controls[0]!;
      expect(loopback.requests).toHaveLength(2);
      const core = (await readFile(join(source, "core/AXIOMS.md"), "utf8")).trim();
      const policyFrame = loopback.requests[0]!.text.split("<!-- hermes-plugin-sections:start -->\n")[1]!
        .split("\n<!-- hermes-plugin-sections:end -->")[0]!
        .replace(/^## Plugin Context: axiom\.policy-\d{3}\n<!-- hermes-plugin-section-chars:\d+ -->\n\n/gm, "");
      expect(policyFrame.includes(core)).toBe(true);
      expect(policyFrame).toContain(bundle!.manifest.policy.digest);
      expect(loopback.requests[1]?.toolResults).toEqual([expect.stringContaining("The request leaves the target audience undecided.")]);
      expect(await snapshotFixture(workspace)).toEqual(before);

      const answer = { request_id: prompt.prompt_id, execution_generation: prompt.execution_generation, answer: "" };
      const clarify = `${route}/clarify`;
      for (const [invalid, error] of [
        [{ ...answer, execution_generation: answer.execution_generation + 1 }, "stale_generation"],
        [{ ...answer, request_id: "wrong-prompt" }, "approval_not_pending"],
      ] as const) {
        const rejected = await request(clarify, invalid);
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({ error: { code: error } });
        expect((await status()).pending_controls).toEqual([prompt]);
        expect(loopback.requests).toHaveLength(2);
      }

      const settled = await request(clarify, answer);
      expect(settled.status).toBe(200);
      expect(await settled.json()).toMatchObject({ status: "resolved", run_id: runId, prompt_id: prompt.prompt_id });
      const completed = await poll(async () => {
        const state = await status();
        return state.status === "completed" ? state : undefined;
      }, "The run did not resume after the matching control.", signal);
      expect(completed).toMatchObject({ run_id: runId, session_id: sessionId, admission_id: waiting.admission_id,
        execution_generation: waiting.execution_generation, pending_controls: [] });
      expect((await request(clarify, answer)).status).toBe(409);
      expect(loopback.requests).toHaveLength(3);
      expect(JSON.parse(loopback.requests[2]!.toolResults[1]!)).toMatchObject({ responses: [{ question,
        status: "answered", user_response: choices[1] }] });

      const receipt = await request(`${route}/events`);
      expect(receipt.status).toBe(200);
      const events = (await receipt.text()).split("\n").filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as RunEvent);
      expect(events.every(({ run_id }) => run_id === runId)).toBe(true);
      expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index));
      const read = events.find(({ event, tool }) => event === "tool.completed" && tool === "read_file")!;
      const ask = events.find(({ event, tool }) => event === "tool.started" && tool === "clarify")!;
      const requested = events.find(({ event }) => event === "clarify.request")!;
      const resolved = events.find(({ event }) => event === "clarify.settled")!;
      const done = events.find(({ event, tool }) => event === "tool.completed" && tool === "clarify")!;
      expect(read).toMatchObject({ tool_call_id: "call-fixture-1", error: false });
      expect(ask).toMatchObject({ tool_call_id: "call-fixture-2" });
      expect(requested).toMatchObject(prompt);
      expect(resolved).toMatchObject({ prompt_id: prompt.prompt_id, execution_generation: prompt.execution_generation });
      expect(done).toMatchObject({ tool_call_id: ask.tool_call_id, error: false });
      const final = events.find(({ event }) => event === "run.completed")!;
      expect([read.seq, ask.seq, requested.seq, resolved.seq, done.seq, final.seq])
        .toEqual([read.seq, ask.seq, requested.seq, resolved.seq, done.seq, final.seq].sort((a, b) => a - b));
      expect(events.filter(({ event, tool }) => event === "tool.started" && tool !== "read_file" && tool !== "clarify")).toEqual([]);
      const after = await snapshotFixture(workspace);
      expect(after).toEqual(before);
      const policy = bundle!.manifest.policy;
      expect(gradeCase(evaluation, { source: revision, policy, before, after,
        actions: [{ kind: "read", path: "issue.txt" }, { kind: "ask", topic: "target audience" }],
      })[0]?.outcome).toEqual({ status: "passed" });
      expect(gradeCase(evaluation, { source: revision, policy, before, after,
        actions: [{ kind: "read", path: "issue.txt" }],
      })[0]?.outcome.status).toBe("failed");
      expect(await snapshotSource({ root: source })).toEqual(revision);
      process.stdout.write(JSON.stringify({ kind: "installed-hermes-gateway-clarification-loopback", source: revision,
        host: { agent: "hermes", version: hermesVersion, model, os: process.platform, surface: "gateway-runs" },
        profile, bundleDigest: bundle!.manifest.digest, policy,
        mechanism: "installed startup policy in provider request and correlated Runs controls and event stream",
        transport: { status: "passed" },
        realModelClarification: { status: "not_run", reason: "This fixture used a scripted localhost provider." },
        qualification: { status: "blocked", reason: "External model evidence is required." } }) + "\n");
    } finally {
      await stop?.();
      await loopback.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 95_000,
);
