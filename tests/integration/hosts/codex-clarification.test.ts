import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { buildCodexBundle, configureCodexProfile, supportedVersion } from "../../../adapters/codex/src/index.js";
import { nativeVersion, runCodex } from "../../../adapters/codex/src/process.js";
import { loadBundleWorkspace } from "../../../packages/bundles/src/index.js";
import { codexDigest } from "../../../packages/cli/src/native-install.js";
import { snapshotSource } from "../../../packages/evidence/src/index.js";
import { openLoopback } from "./loopback.js";
import { windowsCodexEnvironment, windowsCodexFixture, windowsSandbox } from "./windows-codex.js";

const executable = process.env.AXIOM_TEST_CODEX_BINARY;
const windows = process.platform === "win32";
const model = "gpt-5.4";
const prompt = "Inspect the disposable report format question fixture.";
const fixture = "The report format is undecided.\n";
const questions = [{ id: "format", header: "Format", question: "Which report format should I use?", options: [
  { label: "CSV", description: "Comma-delimited data" }, { label: "JSON", description: "JSON array" },
] }];

interface RpcMessage {
  id?: number | string;
  method?: string;
  error?: { code: number; message: string };
  result?: { thread?: { id: string }; turn?: { id: string } };
  params?: { turn?: { id: string; status: string }; threadId?: string; turnId?: string; itemId?: string };
}

test.runIf(executable && (process.platform === "linux" || windows))(
  "installed Codex Plan-mode app-server waits for the matching native request-user-input response", async () => {
    const source = process.cwd();
    const revision = await snapshotSource({ root: source });
    const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-codex-app-clarify-")));
    const userHome = join(root, "user");
    const profile = { program: executable!, workspace: join(root, "fixture"), home: join(root, "codex"), userHome,
      ...(windows && { environment: windowsCodexEnvironment(userHome) }) };
    const loopback = await openLoopback("codex", model, ({ text, toolResults }) =>
      text.includes(prompt) && !toolResults.length ? { name: "request_user_input", arguments: JSON.stringify({ questions }) } : undefined,
    );
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(35_000)]);
    const events = new PassThrough({ objectMode: true });
    let native: ReturnType<typeof runCodex> | undefined;
    try {
      await Promise.all([mkdir(profile.home), mkdir(profile.userHome), mkdir(profile.workspace)]);
      const project = join(profile.workspace, "report.txt");
      await writeFile(project, fixture);
      await writeFile(join(profile.home, "config.toml"), [
        'model_provider = "fixture"', "[model_providers.fixture]", 'name = "Disposable fixture"',
        `base_url = "${loopback.endpoint}/v1"`, 'wire_api = "responses"', "requires_openai_auth = false",
        "request_max_retries = 0", "stream_max_retries = 0", "", ...(windows ? [windowsSandbox] : []),
      ].join("\n"));
      expect(await nativeVersion(profile, signal)).toBe(supportedVersion);
      const { catalog } = loadBundleWorkspace(source);
      const bundle = await buildCodexBundle({ source, destination: join(root, "bundle"), version: "0.1.0", catalog, profiles: [] });
      if (windows) await windowsCodexFixture(profile, root, signal).install(bundle);
      else await configureCodexProfile(profile, "install", bundle, signal);

      let client: ((message: unknown) => void) | undefined;
      let endInput: (() => void) | undefined;
      native = runCodex(profile, ["app-server", "--stdio"], {
        signal, experimentalApi: true,
        onLine(line, write, end) {
          client = write;
          endInput = end;
          events.write(JSON.parse(line));
        },
      });
      void native.then(() => events.end(), (error) => events.destroy(error));
      const messages = events[Symbol.asyncIterator]();
      const receive = async (matches: (message: RpcMessage) => boolean) => {
        while (true) {
          const { value, done } = await messages.next();
          if (done) throw new Error("The native app-server ended before sending the expected event.");
          if (matches(value)) return value as RpcMessage;
        }
      };
      expect((await receive(({ id }) => id === 1)).result).toBeDefined();
      client!({ method: "initialized" });
      client!({ id: 2, method: "thread/start", params: { cwd: profile.workspace, model,
        approvalPolicy: "never", sandbox: "read-only", ephemeral: true } });
      const threadId = (await receive(({ id }) => id === 2)).result?.thread?.id;
      expect(threadId).toBeTruthy();
      client!({ id: 3, method: "turn/start", params: { threadId, input: [{ type: "text", text: prompt }],
        collaborationMode: { mode: "plan", settings: { model, reasoning_effort: null, developer_instructions: null } } } });
      const started = await receive(({ id }) => id === 3);
      expect(started.error).toBeUndefined();
      const turnId = started.result?.turn?.id;
      expect(turnId).toBeTruthy();
      const ask = await receive(({ method }) => method === "item/tool/requestUserInput" || method === "turn/completed");
      expect(ask).toMatchObject({ id: expect.any(Number), method: "item/tool/requestUserInput",
        params: { threadId, turnId, itemId: "call_fixture_1", isBlocking: true, questions } });
      expect(loopback.requests).toHaveLength(1);
      expect(loopback.requests[0]!.text.includes(bundle.instructions)).toBe(true);

      client!({ id: Number(ask.id) + 100, result: { answers: { format: { answers: ["CSV"] } } } });
      await delay(300, undefined, { signal });
      expect(loopback.requests).toHaveLength(1);
      expect(await readFile(project, "utf8")).toBe(fixture);
      client!({ id: ask.id, result: { answers: {} } });
      const terminal = await receive(({ method }) => method === "turn/completed");
      expect(terminal).toMatchObject({ params: { threadId, turn: { id: turnId, status: "completed" } } });
      expect(loopback.requests).toHaveLength(2);
      expect(loopback.requests[1]!.toolResults.map((result) => JSON.parse(result))).toEqual([{ answers: {} }]);
      expect(await readFile(project, "utf8")).toBe(fixture);
      expect(await readdir(profile.workspace)).toEqual(["report.txt"]);
      endInput!();
      expect((await native).code).toBe(0);
      expect(await snapshotSource({ root: source })).toEqual(revision);
      process.stdout.write(JSON.stringify({ kind: "installed-codex-app-server-clarification-loopback", source: revision,
        host: { agent: "codex", version: supportedVersion, model, os: process.platform, surface: "app-server-plan" },
        bundleDigest: await codexDigest(bundle.root), policy: bundle.policy,
        mechanism: "installed AGENTS.md observed in the native Responses request and correlated blocking app-server input",
        transport: { status: "passed" },
        realModelClarification: { status: "not_run", reason: "This fixture used a scripted localhost provider." },
        qualification: { status: "blocked", reason: "External model evidence is required." } }) + "\n");
    } finally {
      stop.abort();
      await native?.catch(() => undefined);
      events.destroy();
      await loopback.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000,
);
