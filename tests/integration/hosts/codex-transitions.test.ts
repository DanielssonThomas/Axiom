import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { buildCodexBundle, configureCodexProfile, observeCodexProfile, supportedVersion } from "../../../adapters/codex/src/index.js";
import { nativeVersion, runCodex } from "../../../adapters/codex/src/process.js";
import { loadBundleWorkspace } from "../../../packages/bundles/src/index.js";
import { codexDigest } from "../../../packages/cli/src/native-install.js";
import { snapshotSource } from "../../../packages/evidence/src/index.js";
import { openLoopback } from "./loopback.js";

const executable = process.env.AXIOM_TEST_CODEX_BINARY;
const model = "gpt-5.4";
const originalPrompt = "Remember disposable fixture marker first-praxis-126.";
const resumedPrompt = "Acknowledge the retained fixture history.";

interface Thread {
  id: string;
  turns: { items: { type: string; content?: unknown }[] }[];
}

interface Turn {
  id: string;
  status: string;
}

interface Message {
  id?: number;
  method?: string;
  error?: unknown;
  result?: { thread?: Thread; turn?: Turn };
  params?: { threadId?: string; turnId?: string; item?: { type?: string }; turn?: Turn };
}

test.runIf(executable && process.platform === "linux")(
  "observes installed Codex policy across resume and native compaction and detects retained policy after disable", async () => {
    const source = process.cwd();
    const revision = await snapshotSource({ root: source });
    const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-codex-transition-")));
    const profile = { program: executable!, workspace: join(root, "project"), home: join(root, "codex"), userHome: join(root, "user") };
    const loopback = await openLoopback("codex", model);
    const signal = AbortSignal.timeout(40_000);
    const running = new Map<AbortController, ReturnType<typeof runCodex>>();
    try {
      await Promise.all([mkdir(profile.home), mkdir(profile.userHome), mkdir(profile.workspace)]);
      const project = join(profile.workspace, "fixture.txt");
      const fixture = "The disposable fixture stays unchanged.\n";
      await writeFile(project, fixture);
      await writeFile(join(profile.home, "config.toml"), [
        'model_provider = "fixture"', 'model = "gpt-5.4"', "[model_providers.fixture]",
        'name = "Disposable fixture"', 'base_url = "' + loopback.endpoint + '/v1"',
        'wire_api = "responses"', "requires_openai_auth = false", "request_max_retries = 0", "stream_max_retries = 0", "",
      ].join("\n"));
      expect(await nativeVersion(profile, signal)).toBe(supportedVersion);
      const { catalog } = loadBundleWorkspace(source);
      const bundle = await buildCodexBundle({ source, catalog, destination: join(root, "bundle"), version: "0.1.0", profiles: [] });
      const updated = await buildCodexBundle({
        source, catalog, destination: join(root, "updated"), version: "0.1.1", profiles: ["ui-atomic"],
      });
      const sandbox = { cwd: profile.workspace, model, approvalPolicy: "never", sandbox: "read-only" };

      const open = async () => {
        let send: (value: unknown) => void;
        let end: () => void;
        const messages = new PassThrough({ objectMode: true });
        const compactions: Message[] = [];
        const stop = new AbortController();
        const native = runCodex(profile, ["app-server", "--stdio"], {
          signal: AbortSignal.any([signal, stop.signal]), experimentalApi: true,
          onLine(line, write, endInput) {
            send = write;
            end = endInput;
            const message: Message = JSON.parse(line);
            if (message.method === "item/completed" && message.params?.item?.type === "contextCompaction") compactions.push(message);
            messages.write(message);
          },
        });
        running.set(stop, native);
        void native.then(() => messages.end(), (error) => messages.destroy(error));
        const events = messages[Symbol.asyncIterator]();
        const receive = async (matches: (message: Message) => boolean) => {
          while (true) {
            const { value, done } = await events.next();
            if (done) throw new Error("The native app-server ended before the expected event.");
            if (matches(value)) return value as Message;
          }
        };
        expect((await receive(({ id }) => id === 1)).result).toBeDefined();
        send!({ method: "initialized" });
        let nextId = 2;
        return {
          receive, compactions,
          async request(method: string, params: object) {
            const id = nextId++;
            send({ id, method, params });
            const response = await receive((message) => message.id === id);
            expect(response.error).toBeUndefined();
            expect(response.result).toBeDefined();
            return response.result!;
          },
          async close() {
            end();
            expect((await native).code).toBe(0);
            running.delete(stop);
          },
        };
      };

      type Client = Awaited<ReturnType<typeof open>>;
      const turn = async (client: Client, threadId: string, text: string) => {
        const started = await client.request("turn/start", { threadId, input: [{ type: "text", text }] });
        const completed = await client.receive(({ method, params }) =>
          method === "turn/completed" && params?.threadId === threadId && params?.turn?.id === started.turn?.id);
        expect(completed.params?.turn?.status).toBe("completed");
      };

      await configureCodexProfile(profile, "install", bundle, signal);
      const initial = await open();
      const threadId = (await initial.request("thread/start", sandbox)).thread?.id;
      expect(threadId).toBeTruthy();
      await turn(initial, threadId!, originalPrompt);
      expect(loopback.requests).toHaveLength(1);
      expect(loopback.requests[0]?.text.includes(bundle.instructions)).toBe(true);
      await initial.close();

      await configureCodexProfile(profile, "update", updated, signal);
      const resumed = await open();
      const history = (await resumed.request("thread/resume", { ...sandbox, threadId })).thread;
      expect(history?.id).toBe(threadId);
      expect(history?.turns.some(({ items }) => items.some(({ type, content }) =>
        type === "userMessage" && JSON.stringify(content).includes(originalPrompt)))).toBe(true);
      await turn(resumed, threadId!, resumedPrompt);
      expect(loopback.requests).toHaveLength(2);
      const resumedInput = loopback.requests[1]!.text;
      expect(resumedInput).toContain(originalPrompt);
      expect(resumedInput).toContain(resumedPrompt);
      expect(resumedInput.includes(updated.instructions)).toBe(true);

      await resumed.request("thread/compact/start", { threadId });
      const compactedTurn = await resumed.receive(({ method, params }) =>
        method === "turn/completed" && params?.threadId === threadId);
      expect(compactedTurn.params?.turn?.status).toBe("completed");
      expect(resumed.compactions).toEqual([expect.objectContaining({ params: expect.objectContaining({
        threadId, turnId: compactedTurn.params?.turn?.id,
      }) })]);
      expect(loopback.requests).toHaveLength(3);
      expect(loopback.requests[2]!.text.includes(updated.instructions)).toBe(true);
      const compactedPrompt = "Acknowledge the conversation after the native compaction.";
      await turn(resumed, threadId!, compactedPrompt);
      expect(loopback.requests).toHaveLength(4);
      expect(loopback.requests[3]!.text).toContain(compactedPrompt);
      expect(loopback.requests[3]!.text.includes(updated.instructions)).toBe(true);
      await resumed.close();

      await configureCodexProfile(profile, "disable", undefined, signal);
      expect(await observeCodexProfile(profile, signal)).toMatchObject({ selected: false, skills: [] });
      const disabled = await open();
      expect((await disabled.request("thread/resume", { ...sandbox, threadId })).thread?.id).toBe(threadId);
      await turn(disabled, threadId!, "Continue the retained thread with Axiom disabled.");
      expect(loopback.requests).toHaveLength(5);
      // This pinned host retains policy on existing threads. The receipt must leave
      // general resume qualification blocked even though fresh disabled threads omit it.
      expect(loopback.requests[4]!.text.includes(updated.instructions)).toBe(true);
      const fresh = (await disabled.request("thread/start", sandbox)).thread?.id;
      expect(fresh).toBeTruthy();
      expect(fresh).not.toBe(threadId);
      await turn(disabled, fresh!, "Acknowledge the new thread with Axiom disabled.");
      expect(loopback.requests).toHaveLength(6);
      expect(loopback.requests[5]!.text.includes(updated.instructions)).toBe(false);
      expect(loopback.requests[5]!.text.includes(bundle.instructions)).toBe(false);
      await disabled.close();

      expect(await readFile(project, "utf8")).toBe(fixture);
      expect(await snapshotSource({ root: source })).toEqual(revision);
      process.stdout.write(JSON.stringify({
        kind: "installed-codex-app-server-transitions-loopback", source: revision,
        host: { agent: "codex", version: supportedVersion, model, os: process.platform, surface: "app-server" },
        bundleDigest: await codexDigest(bundle.root), policy: bundle.policy,
        updatedBundleDigest: await codexDigest(updated.root), updatedPolicy: updated.policy,
        resumedPolicy: { status: "passed" }, compactedPolicy: { status: "passed" },
        disabledFreshThread: { status: "passed" },
        disabledResume: { status: "blocked", reason: "The retained thread sent its previous installed policy after disable." },
        qualification: { status: "blocked", reason: "General resume and compaction enforcement and external model behavior are unverified." },
      }) + "\n");
    } finally {
      for (const stop of running.keys()) stop.abort();
      await Promise.allSettled(running.values());
      await loopback.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000,
);
