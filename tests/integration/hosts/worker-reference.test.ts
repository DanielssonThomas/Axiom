import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { PolicyIdentity, TaskBrief } from "@axiom/contracts";
import { openLoopback } from "./loopback.js";
import { codexSettledFixture, hermesSettledFixture } from "./native-settled.js";
import { reviewWorkerReference, verifyWorkerReference } from "./worker-reference.js";

const policy: PolicyIdentity = { version: "1", digest: "sha256:" + "a".repeat(64), profiles: [] };
const brief: TaskBrief = {
  id: "worker-task", parentId: "parent-task", objective: "Make the isolated change.",
  ownedPaths: ["src/value.mjs"], policy, criteria: [{ id: "value", description: "Keep the public interface.", required: true }],
  requiredCapabilities: ["process-execution"], limits: { timeoutMs: 30_000, maxAttempts: 1, maxConcurrency: 1 },
};
const contents = JSON.stringify(brief) + "\n";
const digest = "sha256:" + createHash("sha256").update(contents).digest("hex");
const evidence = {
  policy, parent: "parent-thread", worker: { id: "worker-thread", parent: "parent-thread", startedOrder: 4, completed: true },
  prepared: { thread: "parent-thread", path: ".axiom/worker-brief.json", contents, digest, order: 3 },
  read: { thread: "worker-thread", path: ".axiom/worker-brief.json", contents, order: 5 },
  firstEdit: { thread: "worker-thread", order: 6 },
};

test("binds the observed worker input to a parent-authored brief before the worker edits", () => {
  expect(verifyWorkerReference(evidence)).toEqual({ outcome: { status: "passed" }, brief });
});

test("rejects unrelated workers, changed bytes, stale reads, and the wrong policy", () => {
  for (const invalid of [
    { worker: { ...evidence.worker, parent: "other-parent" } },
    { worker: { ...evidence.worker, startedOrder: 2 } },
    { read: { ...evidence.read, thread: evidence.parent } },
    { read: { ...evidence.read, contents: contents + " " } },
    { read: { ...evidence.read, path: "other.json" } },
    { read: { ...evidence.read, order: 7 } },
    { prepared: { ...evidence.prepared, digest: policy.digest } },
    { prepared: { ...evidence.prepared, path: "../worker-brief.json" } },
    { policy: { ...policy, digest: "sha256:" + "b".repeat(64) } },
  ]) expect(verifyWorkerReference({ ...evidence, ...invalid }).outcome.status).not.toBe("passed");
});

test("matches native pre and post events for the correlated worker and blocks gaps", () => {
  const common = { session: evidence.parent, cwd: "/fixture", source: { digest: "before" }, turn: "turn" };
  const pre = (id: string, time: number, agent?: string) => ({
    ...common, id, event: "PreToolUse", startedAt: new Date(time).toISOString(), ...(agent && { agent }),
  });
  const post = (row: ReturnType<typeof pre>, time: number, reference?: "sha256sum" | "cat") => ({
    ...row, event: "PostToolUse", startedAt: new Date(time).toISOString(), ...(reference && {
      reference: { operation: reference, path: evidence.prepared.path, contents, digest },
    }),
  });
  const prepare = pre("prepare", 1);
  const read = pre("read", 5, evidence.worker.id);
  const edit = pre("edit", 7, evidence.worker.id);
  const complete = { ...post(edit, 8), source: { digest: "after" } };
  const journal = [prepare, post(prepare, 3, "sha256sum"), read, post(read, 6, "cat"), edit, complete];
  expect(reviewWorkerReference(evidence, "/fixture", journal)).toEqual({ outcome: { status: "passed" }, brief });
  expect(reviewWorkerReference(evidence, "/fixture", journal.slice(0, -1)).outcome.status).toBe("blocked");
});

const codex = process.env.AXIOM_TEST_CODEX_BINARY;
const hermes = process.env.AXIOM_HERMES_CLI;
for (const host of ["codex", "hermes"] as const) {
  const program = host === "codex" ? codex : hermes;
  const launch = host === "codex" ? codexSettledFixture : hermesSettledFixture;
  test.runIf(process.platform === "linux" && !!program)("blocks a narrowed verification in the installed " + host + " project workflow", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-protected-suite-")));
    const workspace = join(root, "workspace");
    const journal = join(root, "commands.jsonl");
    const repository = await realpath(process.cwd());
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const model = host === "codex" ? "gpt-5.4" : "fixture-model";
    const commands = ["node --test narrow.test.mjs", "node --test"];
    const provider = await openLoopback(host, model, ({ toolResults }) => {
      const next = commands[toolResults.length];
      if (next) return host === "codex"
        ? { name: "exec_command", arguments: JSON.stringify({ cmd: next, workdir: workspace, login: false }) }
        : { name: "terminal", arguments: JSON.stringify({ command: next, workdir: workspace, timeout: 10 }) };
    });
    try {
      await mkdir(workspace);
      await writeFile(join(workspace, "AGENTS.md"), "The verification command is `node --test`.\n");
      await writeFile(join(workspace, "protected.test.mjs"), "import { test } from 'node:test'; test('protected example', () => {});\n");
      execFileSync("git", ["init", "--quiet"], { cwd: workspace, stdio: "ignore" });
      await launch({ root, repository, revision, workspace, program: program!, prompt: "Verify the disposable workspace.",
        model, endpoint: provider.endpoint, journal, signal: AbortSignal.timeout(55_000) });
      const output = provider.requests.flatMap(({ toolResults }) => toolResults);
      expect(output.some((result) => result.includes("Run the documented verification command"))).toBe(true);
      expect(output.some((result) => result.includes("ok 1 - protected example"))).toBe(true);
    } finally {
      await provider.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 60_000);
}
test.runIf(process.platform === "linux" && !!codex)("captures the exact digest and bytes through native Codex command hooks", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "axiom-worker-reference-")));
  const workspace = join(root, "workspace");
  const journal = join(root, "commands.jsonl");
  const repository = await realpath(process.cwd());
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const model = "gpt-5.4";
  const command = ["sha256sum -- .axiom/worker-brief.json", "cat -- .axiom/worker-brief.json"];
  const provider = await openLoopback("codex", model, ({ toolResults }) => {
    const next = command[toolResults.length];
    if (next) return { name: "exec_command", arguments: JSON.stringify({ cmd: next, workdir: workspace, login: false }) };
  });
  try {
    await mkdir(join(workspace, ".axiom"), { recursive: true });
    await writeFile(join(workspace, evidence.prepared.path), contents);
    execFileSync("git", ["init", "--quiet"], { cwd: workspace, stdio: "ignore" });
    await codexSettledFixture({ root, repository, revision, workspace, program: codex!, prompt: "Inspect the disposable workspace.",
      model, endpoint: provider.endpoint, journal, signal: AbortSignal.timeout(25_000) });
    const entries = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.flatMap(({ reference }) => reference ? [reference] : [])).toEqual([
      { operation: "sha256sum", path: evidence.prepared.path, contents, digest },
      { operation: "cat", path: evidence.prepared.path, contents, digest },
    ]);
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 30_000);
