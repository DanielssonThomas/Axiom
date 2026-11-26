import { createHash } from "node:crypto";
import { appendFile, lstat, readFile, realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { snapshotSource } from "../../../packages/evidence/dist/index.js";

const [workspace, journal] = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
const extra = event.extra ?? {};
const result = typeof extra.result === "string" ? JSON.parse(extra.result) : extra.result;
const command = event.tool_input?.command ?? event.tool_input?.cmd;
const phase = event.hook_event_name;

async function observedReference() {
  if (event.tool_name !== "Bash" || typeof command !== "string" || phase !== "PostToolUse") return;
  const match = /^(cat|sha256sum)(?: --)? ['"]?([.a-zA-Z0-9/_-]+\.json)['"]?$/.exec(command);
  if (!match) return;
  const [, operation, path] = match;
  if (!path.startsWith(".axiom/") || posix.normalize(path) !== path) return;
  const file = resolve(workspace, path);
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > 16_384 || await realpath(file) !== file) return;
  const contents = await readFile(file, "utf8");
  const sha = createHash("sha256").update(contents).digest("hex");
  const response = event.tool_response;
  const output = typeof response === "string" ? response : response?.output ?? response?.text;
  if (typeof output !== "string") return;
  const observed = operation === "cat" ? output.includes(contents)
    : output.split(/\r?\n/).includes(sha + "  " + path);
  if (observed) return { operation, path, contents, digest: "sha256:" + sha };
}

await appendFile(journal, JSON.stringify({
  event: phase,
  session: event.session_id,
  ...(typeof event.agent_id === "string" && { agent: event.agent_id }),
  turn: event.turn_id ?? extra.turn_id,
  id: event.tool_use_id ?? extra.tool_call_id,
  cwd: event.tool_input?.workdir ?? event.cwd,
  tool: event.tool_name,
  command,
  path: event.tool_input?.path,
  source: await snapshotSource({ root: workspace }),
  startedAt: new Date().toISOString(),
  exitCode: result?.exit_code,
  stdout: result?.output,
  reference: await observedReference(),
}) + "\n", { mode: 0o600 });
process.stdout.write("{}\n");
