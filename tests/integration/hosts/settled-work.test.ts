import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { evaluationCaseSchema, sourceIdentitySchema, type Evidence, type SourceIdentity } from "@axiom/contracts";
import { gradeCase, type GradingAction } from "../../../evals/graders/index.js";
import { EvidenceStore, snapshotSource } from "../../../packages/evidence/src/index.js";
import { openLoopback } from "./loopback.js";
import { codexSettledFixture, hermesSettledFixture } from "./native-settled.js";
import { observedNodeTests } from "./native-test-evidence.js";

const regressionFile = "test/catalog-command.test.mjs";
const commandFile = "src/catalog-command.mjs";
const acceptance = "catalog command acceptance";
const regression = "formats multiword catalog keys";
const criterion = "demonstrate-prevention";
const testCommand = "node --test";

const hosts = [
  { agent: "codex", model: "gpt-5.4", program: process.env.AXIOM_TEST_CODEX_BINARY, launch: codexSettledFixture },
  { agent: "hermes", model: "fixture-model", program: process.env.AXIOM_HERMES_CLI, launch: hermesSettledFixture },
] as const;

interface Boundary {
  event: string;
  session: string;
  turn: string;
  id: string;
  cwd: string;
  tool: string;
  path?: string;
  command?: string;
  source: SourceIdentity;
  startedAt: string;
  exitCode?: number;
  stdout?: string;
}

async function contents(workspace: string) {
  const entries = await readdir(workspace, { recursive: true, withFileTypes: true });
  return new Map(await Promise.all(entries.filter((file) => file.isFile() && !file.parentPath.split("/").includes(".git"))
    .map(async ({ parentPath, name }) => {
      const path = join(parentPath, name);
      return [relative(workspace, path), await readFile(path, "utf8")] as const;
    })));
}

function lines(output: string) {
  return output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function steps(before: ReadonlyMap<string, string>) {
  const testContents = before.get(regressionFile)!.trimEnd() + "\n\n"
    + "test('formats multiword catalog keys', () => {\n  assert.equal(run(' Alpine Camp '), 'alpine-camp');\n});\n";
  const repaired = "import { formatCatalogKey } from './catalog-key.mjs';\n\n"
    + before.get(commandFile)!.replace("label.trim().toLowerCase()", "formatCatalogKey(label)");
  const node = (code: string) => "node -e " + JSON.stringify(code);
  const read = (path: string) => ({ kind: "read", path, command: node("process.stdout.write(require('node:fs').readFileSync('"
    + path + "', 'utf8'))") } as const);
  const write = (path: string, value: string) => ({ kind: "edit", path, value, command: node("require('node:fs').writeFileSync('"
    + path + "', Buffer.from('" + Buffer.from(value).toString("base64") + "', 'base64'))") } as const);
  return [
    read("issue.txt"), read("AGENTS.md"), read(regressionFile), read(commandFile), write(regressionFile, testContents),
    { kind: "check", stage: "red", command: testCommand },
    write(commandFile, repaired),
    { kind: "check", stage: "green", command: testCommand },
  ] as const;
}

interface Completion {
  id: string;
  command: string;
  exitCode: number;
  text: string;
}

function completions(output: string, codex: boolean, boundaries: Boundary[]) {
  const events = lines(output);
  if (codex) {
    expect(events.filter(({ type }) => type === "turn.completed")).toHaveLength(1);
    const sessions = events.filter(({ type }) => type === "thread.started");
    expect(sessions).toHaveLength(1);
    return {
      session: sessions[0].thread_id,
      calls: events.filter(({ type, item }) => type === "item.completed" && item?.type === "command_execution")
        .map(({ item }): Completion => ({ id: item.id, command: item.command, exitCode: item.exit_code, text: item.aggregated_output })),
    };
  }
  const result = events.filter(({ type }) => type === "result");
  expect(result).toHaveLength(1);
  return {
    session: result[0].session_id,
    calls: events.filter(({ type, name }) => type === "tool_result" && ["terminal", "read_file", "write_file"].includes(name))
      .map((event, index): Completion => {
        const native = JSON.parse(event.output);
        if (event.name !== "terminal") return { id: event.tool_call_id, command: event.name,
          exitCode: event.is_error || native.error ? -1 : 0, text: native.content ?? event.output };
        const boundary = boundaries[index * 2 + 1]!;
        expect(native.exit_code).toBe(boundary.exitCode);
        expect(native.output).toBe(boundary.stdout);
        return { id: event.tool_call_id, command: boundary.command!, exitCode: native.exit_code, text: native.output };
      }),
  };
}

for (const { agent, model, program, launch } of hosts) {
  test.runIf(process.platform === "linux" && !!program)(agent + " binds native RED and GREEN to their fixture source", async () => {
    const repository = await realpath(process.cwd());
    const source = await snapshotSource({ root: repository });
    expect(source.revision).toBeTruthy();
    const definition = evaluationCaseSchema.parse(JSON.parse(await readFile(join(repository, "evals", "cases",
      "settled-catalog-repair.json"), "utf8")));
    const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-settled-")));
    const workspace = join(root, "workspace");
    const journal = join(root, "commands.jsonl");
    let provider: Awaited<ReturnType<typeof openLoopback>> | undefined;
    try {
      await cp(join(repository, definition.fixture), workspace, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
      git("init", "--quiet");
      git("add", ".");
      git("-c", "user.name=Axiom Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "Seed fixture");
      const seed = await snapshotSource({ root: workspace });
      const before = await contents(workspace);
      const sequence = steps(before);
      const codex = agent === "codex";
      let index = 0;
      // The scripted provider sends one tool call at a time, so the native completions and hook pairs share an order.
      provider = await openLoopback(agent, model, () => {
        const step = sequence[index++];
        if (!step) return;
        if (codex) return { name: "exec_command", arguments: JSON.stringify({ cmd: step.command,
          workdir: workspace, login: false, max_output_tokens: 3_000, yield_time_ms: 10_000 }) };
        if (step.kind === "check") return { name: "terminal", arguments: JSON.stringify({ command: step.command,
          workdir: workspace, background: false, timeout: 15 }) };
        return { name: step.kind === "read" ? "read_file" : "write_file", arguments: JSON.stringify({
          path: join(workspace, step.path), ...(step.kind === "edit" ? { content: step.value } : {}),
        }) };
      });
      const { host, policy, bundleDigest, output } = await launch({ root, repository, revision: source.revision!,
        workspace, program: program!, prompt: definition.prompt, model, endpoint: provider.endpoint, journal,
        signal: AbortSignal.timeout(85_000) });
      const prompt = provider.requests[0]?.text ?? "";
      expect(prompt.includes(policy.digest) && prompt.includes("# Axiom Core") && prompt.includes(definition.prompt)).toBe(true);

      const boundaries = lines(await readFile(journal, "utf8")) as Boundary[];
      const { session, calls } = completions(output, codex, boundaries);
      expect(boundaries).toHaveLength(sequence.length * 2);
      expect(calls).toHaveLength(sequence.length);
      expect(new Set(calls.map(({ id }) => id)).size).toBe(sequence.length);
      const commands = new Set<string>();
      const store = new EvidenceStore(join(root, "evidence"));
      await mkdir(store.directory, { mode: 0o700 });
      const sourceAfter = await snapshotSource({ root: workspace });
      const actions: GradingAction[] = [];
      const receipts: { stage: "red" | "green"; source: string; exitCode: number; report: string }[] = [];
      let previous = seed;
      for (const [position, step] of sequence.entries()) {
        const start = boundaries[2 * position]!;
        const finish = boundaries[2 * position + 1]!;
        const native = calls[position]!;
        expect(start.event).toBe(codex ? "PreToolUse" : "pre_tool_call");
        expect(finish.event).toBe(codex ? "PostToolUse" : "post_tool_call");
        expect(start.id && start.turn && session).toBeTruthy();
        expect(start.session).toBe(session);
        expect(finish).toMatchObject({ id: start.id, turn: start.turn, session });
        expect(commands.has(start.id)).toBe(false);
        commands.add(start.id);
        expect(sourceIdentitySchema.parse(start.source)).toEqual(previous);
        const post = sourceIdentitySchema.parse(finish.source);
        if (step.kind === "edit") expect(post.digest).not.toBe(previous.digest);
        else expect(post).toEqual(previous);
        previous = post;

        const exitCode = step.kind === "check" && step.stage === "red" ? 1 : 0;
        expect(native.exitCode).toBe(exitCode);
        if (codex || step.kind === "check") {
          expect(start.command).toBe(step.command);
          expect(finish.command).toBe(step.command);
          expect(start.cwd).toBe(workspace);
          expect(finish.cwd).toBe(workspace);
          expect(native.command).toContain(step.kind === "check" ? testCommand : "node -e");
        } else {
          expect(start.path).toBe(join(workspace, step.path));
          expect(finish.path).toBe(start.path);
          expect(start.tool).toBe(native.command);
        }
        if (!codex) expect(native.id).toBe(start.id);
        if (step.kind !== "check") {
          if (step.kind === "read") expect(native.text.replace(/^[ \t]*\d+\|/gm, "")).toContain(before.get(step.path)!.trim());
          actions.push({ kind: step.kind, path: step.path });
          continue;
        }

        const tests = observedNodeTests(native.text, exitCode);
        expect(tests).toContainEqual({ id: acceptance, status: "passed" });
        expect(tests).toContainEqual({ id: regression, status: step.stage === "red" ? "failed" : "passed" });
        if (step.stage === "red") {
          expect(native.text).toContain("AssertionError");
          expect(native.text).toContain("alpine camp");
          expect(native.text).toContain("alpine-camp");
        }
        const id = step.stage + "-native-command";
        const report = step.stage + "-test-report.txt";
        await writeFile(join(store.directory, report), native.text, { mode: 0o600 });
        const artifact = await store.artifact({ kind: "test-report", path: report });
        if (!artifact?.digest) throw new Error("The native test report could not be archived.");
        const evidence: Evidence = { id, taskId: definition.id, criterionIds: [criterion], host, policy, source: start.source,
          provenance: "observed", startedAt: start.startedAt, durationMs: Date.parse(finish.startedAt) - Date.parse(start.startedAt),
          command: { executable: "node", args: ["--test"], cwd: workspace, exitCode }, artifacts: [artifact],
          outcome: exitCode ? { status: "failed", reason: "The observed test command failed." } : { status: "passed" } };
        await store.record(step.stage === "red" ? "red" : "acceptance", evidence);
        actions.push({ kind: "check", evidence, tests: tests! });
        receipts.push({ stage: step.stage, source: start.source.digest, exitCode, report: artifact.digest });
      }
      expect(previous).toEqual(sourceAfter);
      const observation = { before, after: await contents(workspace), source: sourceAfter, policy, actions };
      const grade = gradeCase(definition, observation);
      expect(grade.filter(({ required }) => required).map(({ outcome }) => outcome.status))
        .toEqual(definition.assertions.filter(({ required }) => required).map(() => "passed"));
      const missing = gradeCase(definition, { ...observation, actions: actions.filter(({ kind }) => kind !== "check") });
      expect(missing.find(({ criterionId }) => criterionId === criterion)?.outcome.status).toBe("failed");
      console.log(JSON.stringify({ kind: "installed-native-test-receipts", provider: "scripted-loopback",
        source, host, policy, bundleDigest, receipts,
        grades: grade.map(({ criterionId, outcome }) => ({ criterionId, status: outcome.status })) }));
    } finally {
      await provider?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 90_000);
}
