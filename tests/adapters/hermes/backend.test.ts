import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { backendResultSchema } from "@axiom/contracts";
import { HermesBenchmarkBackend } from "../../../adapters/hermes/src/index.js";

const workspaces: string[] = [];
afterEach(() => {
  for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(tool = "read_file", stream?: { events: unknown[]; processCode: number }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "axiom-hermes-backend-")));
  workspaces.push(directory);
  const home = join(directory, "hermes-home");
  const workspace = join(directory, "workspace");
  const entrypoint = join(directory, "hermes-fixture.cjs");
  mkdirSync(join(home, "profiles/eval"), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(home, "profiles/eval/config.yaml"), "{}\n");
  writeFileSync(entrypoint, `
const fs = require("node:fs");
const { argv } = process;
if (argv.includes("--version")) {
  fs.writeFileSync(process.env.HERMES_HOME + "/version-probed", "yes");
  console.log("Hermes Agent v0.23.3");
  return;
}
if (argv.includes("gateway")) {
  if (!argv.includes("--no-supervise") || !argv.includes("--external-supervisor")) process.exit(7);
  fs.writeFileSync(process.env.HERMES_HOME + "/gateway_state.json", JSON.stringify({
    pid: process.pid, gateway_state: "running", served_profiles: ["eval"],
  }));
  setInterval(() => {}, 1_000);
  return;
}
const prompt = fs.readFileSync(0, "utf8");
if (prompt === "Wait for cancellation") {
  fs.writeFileSync(process.env.HERMES_HOME + "/client-started", "yes");
  process.stdout.write(JSON.stringify({type:"system",subtype:"init",model:"fixture-model"}) + "\\n");
  setInterval(() => {}, 1_000);
  return;
}
if (prompt !== 'A literal $(not shell) task.' || !argv.includes("--format") || !argv.includes("stream-json")
  || !argv.includes("--max-turns") || !argv.includes("2") || argv.includes("--run-budget")
  || !argv.includes("--query-file") || !argv.includes("--profile") || !argv.includes("eval")
  || process.env.HERMES_HOME !== ${JSON.stringify(home)}) process.exit(8);
for (const event of ${JSON.stringify(stream?.events ?? [
    { type: "system", subtype: "init", model: "fixture-model" },
    { type: "tool_use", name: tool, tool_call_id: "call-1", input: { secret: "not archived" } },
    { type: "tool_result", name: tool, tool_call_id: "call-1", is_error: false, duration_ms: 3 },
    { type: "result", session_id: "session-one", exit_code: 0, tokens: { input: 4, output: 1, total: 5 } },
  ])}) console.log(JSON.stringify(event));
process.exitCode = ${stream?.processCode ?? 0};
`);
  const archive = join(directory, "archive");
  const options = {
    executable: process.execPath, arguments: [entrypoint], profile: { home, profile: "eval" },
    archiveDirectory: archive, provider: "custom", maxTurns: 2,
  };
  return {
    directory,
    home,
    archive,
    options,
    backend: new HermesBenchmarkBackend(options),
    request: {
      id: "attempt-1", caseId: "case-1", prompt: "A literal $(not shell) task.", workspace,
      host: { agent: "hermes", version: "0.23.3", model: "fixture-model", os: process.platform, surface: "cli" },
      policy: { version: "1", digest: "sha256:" + "a".repeat(64), profiles: [] },
      mode: "without_axiom" as const, timeoutMs: 3500,
    },
  };
}

test("runs documented Hermes flags with literal stdin and archives normalized native results", async () => {
  const { archive, backend, request } = fixture();
  const actual = backendResultSchema.parse(await backend.run(request, new AbortController().signal));
  expect(actual).toMatchObject({
    requestId: request.id, host: request.host, outcome: { status: "passed" },
    usage: { metering: "reported", inputTokens: 4, outputTokens: 1 },
  });
  const trace = actual.artifacts.find(({ kind }) => kind === "hermes-trace");
  expect(trace?.location).toBeDefined();
  const raw = readFileSync(join(archive, trace!.location), "utf8");
  expect(raw).toContain("read_file");
  expect(raw).not.toContain("not archived");
  expect(raw).not.toContain("A literal");
});

const genericStreamFailure = "The Hermes stream lacked a matching native model and terminal result.";
const initFailure = "credentials or agent init failed";
const privateError = "private-native-startup-detail";
const init = { type: "system", subtype: "init", model: "fixture-model" };
const presession = { type: "result", session_id: "", exit_code: 1, error: initFailure };
test.each([
  { name: "credential or agent initialization", events: [init, presession], processCode: 1,
    reason: "Hermes reported a credential or agent initialization failure before establishing a session." },
  { name: "gateway access refusal", events: [init, { ...presession,
    error: `Gateway inaccessible: unsafe_control_permissions (${privateError})` }], processCode: 1,
    reason: "Hermes refused access to the local gateway control channel before establishing a session." },
  { name: "gateway connection failure", events: [init, { ...presession,
    error: "Gateway connection failed; no local fallback" }], processCode: 1,
    reason: "Hermes could not reach or communicate with the local gateway before establishing a session." },
  { name: "gateway workspace failure", events: [init, { ...presession, error: "workspace_unavailable" }], processCode: 1,
    reason: "The Hermes gateway could not access the disposable workspace before establishing a session." },
  { name: "gateway storage failure", events: [init, { ...presession, error: "storage_unavailable" }], processCode: 1,
    reason: "The Hermes gateway could not access session storage before establishing a session." },
  { name: "gateway startup rejection", events: [init, { ...presession, error: "invalid_params" }], processCode: 1,
    reason: "The Hermes gateway rejected the native session startup request." },
  { name: "gateway launch credentials failure", events: [init, { ...presession, error: "launch_credentials_unavailable" }], processCode: 1,
    reason: "The Hermes gateway could not access launch credentials before establishing a session." },
  { name: "unknown gateway detail", events: [init, { ...presession,
    error: `Gateway inaccessible: unknown_reason (unsafe_control_permissions: ${privateError})` }], processCode: 1,
    reason: "The native Hermes run failed before establishing a session." },
  { name: "another pre-session failure", events: [init, { ...presession, error: privateError }], processCode: 1,
    reason: "The native Hermes run failed before establishing a session." },
  { name: "zero exit without a session", events: [init, { ...presession, exit_code: 0 }], processCode: 0,
    reason: genericStreamFailure },
  { name: "inconsistent process exit", events: [init, presession], processCode: 2, reason: genericStreamFailure },
  { name: "another model", events: [{ ...init, model: "other-model" }, presession], processCode: 1, reason: genericStreamFailure },
  { name: "a result followed by an event", events: [init, presession, init], processCode: 1, reason: genericStreamFailure },
])("blocks $name without archiving the raw Hermes stream", async ({ events, processCode, reason }) => {
  const { backend, request } = fixture("read_file", { events, processCode });
  const actual = await backend.run(request, new AbortController().signal);
  expect(actual.outcome).toEqual({ status: "blocked", reason });
  expect(actual.artifacts).toEqual([]);
  expect(actual.host).toBeUndefined();
  expect(JSON.stringify(actual)).not.toContain(privateError);
});

test("blocks archive and profile overlaps before launching Hermes", async () => {
  const { archive, directory, home, options, request } = fixture();
  const redirected = join(directory, "redirected");
  symlinkSync(request.workspace, redirected, "junction");
  for (const archiveDirectory of [join(request.workspace, "archive"), redirected, join(redirected, "subdirectory")]) {
    const backend = new HermesBenchmarkBackend({ ...options, archiveDirectory });
    expect((await backend.run(request, new AbortController().signal)).outcome)
      .toMatchObject({ status: "blocked", reason: expect.stringContaining("archive") });
  }
  const backend = new HermesBenchmarkBackend(options);
  const redirectedHome = join(directory, "redirected-home");
  symlinkSync(home, redirectedHome, "junction");
  for (const workspace of [home, redirectedHome]) {
    expect((await backend.run({ ...request, workspace }, new AbortController().signal)).outcome)
      .toMatchObject({ status: "blocked", reason: expect.stringContaining("profile") });
  }
  mkdirSync(archive);
  symlinkSync(request.workspace, join(archive, "acceptance"), "junction");
  expect((await backend.run(request, new AbortController().signal)).outcome)
    .toMatchObject({ status: "blocked", reason: expect.stringContaining("redirected") });
  expect(existsSync(join(request.workspace, "subdirectory"))).toBe(false);
  expect(existsSync(join(home, "version-probed"))).toBe(false);
});

test("marks aggregate token usage unknown when native delegation omits the worker's tokens", async () => {
  const { backend, request } = fixture("delegate_task");
  const actual = backendResultSchema.parse(await backend.run(request, new AbortController().signal));
  expect(actual).toMatchObject({
    outcome: { status: "passed" }, usage: { metering: "unknown", reason: expect.stringContaining("worker") },
  });
  expect(actual.usage).not.toHaveProperty("inputTokens");
  expect(actual.usage).not.toHaveProperty("outputTokens");
});

test("cancels a running host and reports unavailable activation and bounded timeout", async () => {
  const { backend, request, home } = fixture();
  const abort = new AbortController();
  const running = backend.run({ ...request, prompt: "Wait for cancellation" }, abort.signal);
  await vi.waitFor(() => expect(existsSync(join(home, "client-started"))).toBe(true), { timeout: 3_000 });
  abort.abort();
  expect((await running).outcome).toMatchObject({ status: "blocked", reason: expect.stringContaining("cancel") });
  const owner = JSON.parse(readFileSync(join(home, "gateway_state.json"), "utf8"));
  expect(() => process.kill(owner.pid, 0)).toThrow();
  expect((await backend.run({ ...request, mode: "with_axiom" }, new AbortController().signal)).outcome)
    .toMatchObject({ status: "blocked", reason: expect.stringContaining("activation") });
  expect((await backend.run({ ...request, prompt: "Wait for cancellation", timeoutMs: 125 }, new AbortController().signal)).outcome)
    .toMatchObject({ status: "blocked", reason: expect.stringContaining("limit") });
});
