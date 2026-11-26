import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceSchema } from "@axiom/contracts";
import { expect, test } from "vitest";
import { changeHermesPlugin, hermesBundleAdapter, hermesVersion, inspectHermesActivation } from "../../../adapters/hermes/src/index.js";
import { openHermesGateway, runHermes } from "../../../adapters/hermes/src/process.js";
import { assembleBundles, loadBundleWorkspace, writeBundles } from "../../../packages/bundles/src/index.js";
import { snapshotSource } from "../../../packages/evidence/src/index.js";
import { openLoopback } from "./loopback.js";

const executable = process.env.AXIOM_HERMES_CLI;
const model = "fixture-model";
const fixture = "Disposable native resume marker.\n";
const historyTail = "disposable historical tool-result tail 793e15bd";
const history = Array.from({ length: 160 }, (_, index) => `History row ${index} ${"verbally separate archive fields ".repeat(6)}`)
  .join("\n") + `\n${historyTail}\n`;
const initialPrompt = "Keep this identifying note for a later turn: prairie-candle.";
const resumedPrompt = "Continue the same disposable conversation and inspect its fixture without altering it.";
const disabledPrompt = "Continue the existing conversation after the disabled-profile control and inspect the same fixture.";
const refreshedPrompt = "Continue this same conversation after the disabled profile's prompt refresh.";
const freshDisabledPrompt = "Start a fresh disposable conversation in the disabled profile.";

function completeCore(text: string, core: string, policy: string) {
  const sections = text.split("<!-- hermes-plugin-sections:start -->\n")[1]
    ?.split("\n<!-- hermes-plugin-sections:end -->")[0]
    ?.replace(/^## Plugin Context: axiom\.policy-\d{3}\n<!-- hermes-plugin-section-chars:\d+ -->\n\n/gm, "");
  return Boolean(sections?.includes(core) && sections.includes(policy));
}

test.runIf(executable && process.platform === "linux")(
  "pinned Hermes resumes persisted history and keeps installed policy after committed tool-result pruning", async () => {
    const source = process.cwd();
    const revision = await snapshotSource({ root: source });
    const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-hermes-resume-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const profile = "qualification-resume";
    const target = { home, profile };
    const selected = join(home, "profiles", profile);
    const observations = join(selected, ".axiom-hermes");
    const fixturePath = join(workspace, "fixture.txt");
    const historyPath = join(workspace, "history.txt");
    const archive = join(root, "archive");
    const observer = "axiom-transition-probe";
    const observerPath = join(selected, "plugins", observer);
    const compactionLog = join(observerPath, "compactions.jsonl");
    const compactionAtRequest: (string | undefined)[] = [];
    let captureCompaction = false;
    let readRequested = false;
    const loopback = await openLoopback("hermes", model, ({ text }) => {
      if (captureCompaction) compactionAtRequest.push(existsSync(compactionLog) ? readFileSync(compactionLog, "utf8") : undefined);
      if (readRequested || !text.includes(initialPrompt)) return;
      readRequested = true;
      const path = text.includes(resumedPrompt) || text.includes(disabledPrompt) ? fixturePath : historyPath;
      return { name: "read_file", arguments: JSON.stringify({ path }) };
    });
    const command = { executable: executable!, cwd: workspace, signal: AbortSignal.timeout(95_000), deadline: performance.now() + 95_000,
      env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: home, OPENAI_API_KEY: "loopback-only",
        HERMES_TUI_GATEWAY_URL: "", HERMES_NO_SYSTEMD: "1", HERMES_DISABLE_LAZY_INSTALLS: "1", HERMES_DISABLE_AUTO_UPDATE: "1",
        AXIOM_HERMES_NODE: process.execPath, AXIOM_HERMES_ARCHIVE: archive },
    };
    let gateway: Exclude<Awaited<ReturnType<typeof openHermesGateway>>, { interrupted: unknown }> | undefined;
    const stopGateway = async () => {
      await gateway?.stop();
      gateway = undefined;
    };
    const startGateway = async () => {
      const launch = await openHermesGateway({ ...command, args: ["gateway", "run", "--no-supervise", "--external-supervisor"] }, home, profile);
      if ("interrupted" in launch) throw new Error(`The disposable Hermes gateway did not start (${launch.interrupted}).`);
      gateway = launch;
      const state = JSON.parse(await readFile(join(home, "gateway_state.json"), "utf8"));
      expect(state.pid).toEqual(expect.any(Number));
      return state.pid as number;
    };
    const run = async (prompt: string, session?: string) => {
      if (!gateway) throw new Error("The Hermes gateway is unavailable.");
      loopback.requests.length = 0;
      readRequested = false;
      captureCompaction = prompt === resumedPrompt;
      const native = await runHermes({ ...command, signal: AbortSignal.any([command.signal, gateway.signal]),
        input: prompt, args: ["--profile", profile, "chat", "--query-file", "-", "--format", "stream-json", "--model", model,
          "--provider", "custom", "--base-url", `${loopback.endpoint}/v1`, "--max-turns", "3", ...(session ? ["--resume", session] : [])],
      });
      expect(native.code).toBe(0);
      const events = native.stdout.trim().split("\n").map((line) => JSON.parse(line));
      const completed = events.find(({ type }) => type === "result");
      expect(completed?.session_id).toEqual(expect.any(String));
      return { session: completed.session_id as string, events };
    };

    try {
      await mkdir(workspace);
      await writeFile(fixturePath, fixture);
      await writeFile(historyPath, history);
      expect((await runHermes({ ...command, args: ["--version"] })).stdout).toContain(`Hermes Agent v${hermesVersion}`);
      expect((await runHermes({ ...command, args: ["profile", "create", profile, "--no-alias", "--no-credentials", "--no-skills"] })).code).toBe(0);
      await mkdir(observerPath, { recursive: true });
      await writeFile(join(observerPath, "plugin.yaml"), `name: ${observer}\nversion: "1.0.0"\ndescription: "Capture the native compaction event in this disposable test."\n`);
      await writeFile(join(observerPath, "__init__.py"), `import json
from pathlib import Path

def register(ctx):
    def committed(session_id, old_session_id, kind, reason, before_tokens, after_tokens, messages_removed):
        record = dict(session_id=session_id, old_session_id=old_session_id, kind=kind, reason=reason,
                      before_tokens=before_tokens, after_tokens=after_tokens, messages_removed=messages_removed)
        with (Path(__file__).parent / "compactions.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps(record) + "\\n")
    ctx.register_hook("post_compaction", committed)
`);
      await writeFile(join(selected, "config.yaml"), JSON.stringify({
        plugins: { enabled: [observer] }, model: { context_length: 128000 },
        compression: { protect_last_n: 2, proactive_prune_tokens: 1, proactive_prune_min_result_chars: 500,
          proactive_prune_min_reclaim_tokens: 100 },
        auxiliary: { title_generation: { enabled: false } }, updates: { check: false }, kanban: { dispatch_in_gateway: false },
      }));
      const { catalog, skills } = loadBundleWorkspace(source);
      const [bundle] = writeBundles(join(root, "bundles"), assembleBundles(source, {
        version: "0.1.0", sourceRevision: revision.revision ?? revision.digest, policyVersion: catalog.core.version,
        selectedProfiles: [], checks: catalog.checks, skills, adapters: [hermesBundleAdapter],
      }));
      const { policy, digest } = bundle!.manifest;
      const core = (await readFile(join(source, "core", "AXIOMS.md"), "utf8")).trimEnd();
      const hasPolicy = (text: string) => completeCore(text, core, policy.digest);
      const omitsPolicy = (text: string) => !text.includes(policy.digest) && !text.includes("# Axiom Core");
      expect(changeHermesPlugin(target, { kind: "install", bundle: bundle!.directory }).outcome.status).toBe("passed");
      const initialPid = await startGateway();
      const initial = await run(initialPrompt);
      expect(loopback.requests).toHaveLength(2);
      expect(loopback.requests[0]!.systemMessages.some(hasPolicy)).toBe(true);
      const [originalResult] = loopback.requests[1]!.toolResults;
      expect(originalResult).toContain(historyTail);
      expect(inspectHermesActivation(target, initial.session).loaded.status).toBe("passed");
      const receipt = join(observations, `loaded-${initial.session}.json`);
      const acceptance = join(archive, "acceptance");
      const initialChecks = await readdir(acceptance);
      expect(initialChecks).toHaveLength(1);
      await expect(readFile(compactionLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await stopGateway();
      await rm(receipt);
      expect(inspectHermesActivation(target, initial.session).loaded.status).toBe("not_run");
      expect(await startGateway()).not.toBe(initialPid);
      const resumed = await run(resumedPrompt, initial.session);
      expect(resumed.session).toBe(initial.session);
      expect(loopback.requests).toHaveLength(2);
      expect(loopback.requests[0]!.text).toContain(initialPrompt);
      expect(loopback.requests[0]!.text).toContain("Native fixture acknowledged.");
      expect(loopback.requests[0]!.text).toContain(resumedPrompt);
      const [compaction] = (await readFile(compactionLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const continuedAt = compactionAtRequest.findIndex((receipt) => receipt?.split("\n").some((line) =>
        line && JSON.parse(line).session_id === resumed.session,
      ));
      expect(continuedAt).toBeGreaterThanOrEqual(0);
      expect(compaction).toMatchObject({ session_id: resumed.session, old_session_id: "", kind: "prune_tool_results",
        reason: "proactive_prune", before_tokens: expect.any(Number), after_tokens: expect.any(Number) });
      expect(compaction.before_tokens).toBeGreaterThan(compaction.after_tokens);
      const pruned = loopback.requests[continuedAt]!.toolResults[0]!;
      expect(pruned).not.toContain(historyTail);
      const reference = /cache\/pruned\/([a-zA-Z0-9_.-]+\.json)\b/.exec(pruned)?.[1];
      expect(reference).toEqual(expect.any(String));
      expect((await readFile(join(selected, "cache", "pruned", reference!), "utf8")) === originalResult).toBe(true);
      expect(loopback.requests.every(({ model: selectedModel, systemMessages }) =>
        selectedModel === model && systemMessages.some(hasPolicy))).toBe(true);
      expect(resumed.events.find(({ type, name }) => type === "tool_result" && name === "read_file")).toMatchObject({ is_error: false });
      expect(loopback.requests[1]!.toolResults).toEqual([expect.any(String), expect.stringContaining(fixture.trim())]);
      expect(inspectHermesActivation(target, resumed.session)).toMatchObject({ bundleDigest: digest, policy, loaded: { status: "passed" } });
      const afterResume = await readdir(acceptance);
      const checks = await Promise.all(afterResume.filter((file) => !initialChecks.includes(file)).map(async (file) =>
        evidenceSchema.parse(JSON.parse(await readFile(join(acceptance, file), "utf8"))),
      ));
      expect(checks).toEqual([expect.objectContaining({ criterionIds: ["hermes-pre-tool"], policy, outcome: { status: "passed" } })]);
      expect(await readFile(fixturePath, "utf8")).toBe(fixture);
      const lastEnabledReceipt = await readFile(receipt, "utf8");

      await stopGateway();
      expect(changeHermesPlugin(target, { kind: "disable" }).outcome.status).toBe("passed");
      expect(inspectHermesActivation(target, resumed.session)).toMatchObject({ enabled: false, loaded: { status: "blocked" } });
      await startGateway();
      const disabled = await run(disabledPrompt, resumed.session);
      expect(disabled.session).toBe(resumed.session);
      expect(loopback.requests).toHaveLength(2);
      expect(loopback.requests[0]!.text).toContain(initialPrompt);
      expect(loopback.requests[0]!.systemMessages.some(hasPolicy)).toBe(true);
      expect(disabled.events.find(({ type, name }) => type === "tool_result" && name === "read_file")).toMatchObject({ is_error: false });
      expect(await readFile(receipt, "utf8")).toBe(lastEnabledReceipt);
      expect(await readdir(acceptance)).toEqual(afterResume);
      expect(inspectHermesActivation(target, resumed.session)).toMatchObject({ enabled: false, loaded: { status: "blocked" } });
      const refresh = await runHermes({ ...command,
        args: ["--profile", profile, "sessions", "refresh-prompts", "--session", resumed.session, "--json"],
      });
      expect(refresh.code).toBe(0);
      expect(JSON.parse(refresh.stdout)).toMatchObject({ session_id: resumed.session, sessions: 1, epoch: expect.any(Number) });
      expect((await run(refreshedPrompt, resumed.session)).session).toBe(resumed.session);
      expect(loopback.requests[0]!.text).toContain(initialPrompt);
      expect(loopback.requests[0]!.systemMessages).not.toHaveLength(0);
      expect(loopback.requests[0]!.systemMessages.every(omitsPolicy)).toBe(true);
      expect(await readFile(receipt, "utf8")).toBe(lastEnabledReceipt);
      expect(await readdir(acceptance)).toEqual(afterResume);
      expect((await run(freshDisabledPrompt)).session).not.toBe(resumed.session);
      expect(loopback.requests).toHaveLength(1);
      expect(loopback.requests[0]!.systemMessages).not.toHaveLength(0);
      expect(loopback.requests[0]!.systemMessages.every(omitsPolicy)).toBe(true);
      expect(await readFile(historyPath, "utf8")).toBe(history);
      expect(await snapshotSource({ root: source })).toEqual(revision);
      process.stdout.write(JSON.stringify({ kind: "installed-hermes-resume-loopback", source: revision,
        host: { agent: "hermes", version: hermesVersion, model, os: process.platform, surface: "named-profile-cli-resume" },
        profile, bundleDigest: digest, policy, mechanism: "same persisted native session after gateway restart with independently observed wire and pre-tool check",
        compaction: { status: "passed", kind: compaction.kind, reason: compaction.reason,
          beforeTokens: compaction.before_tokens, afterTokens: compaction.after_tokens },
        transport: { status: "passed" }, disabled: { status: "blocked", reason: "Native resume retained the cached system prompt without a fresh Axiom observation or pre-tool check." },
        targetedRefresh: { status: "passed" }, realModelBehavior: { status: "not_run", reason: "The native requests used a scripted localhost provider." },
        qualification: { status: "blocked", reason: "This probe used a scripted localhost provider." },
      }) + "\n");
    } finally {
      await stopGateway();
      await loopback.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 105_000,
);
