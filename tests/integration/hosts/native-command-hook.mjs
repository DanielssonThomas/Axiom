import { appendFile } from "node:fs/promises";
import { snapshotSource } from "../../../packages/evidence/dist/index.js";

const [workspace, journal] = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
const extra = event.extra ?? {};
const result = typeof extra.result === "string" ? JSON.parse(extra.result) : extra.result;
await appendFile(journal, JSON.stringify({
  event: event.hook_event_name,
  session: event.session_id,
  turn: event.turn_id ?? extra.turn_id,
  id: event.tool_use_id ?? extra.tool_call_id,
  cwd: event.tool_input?.workdir ?? event.cwd,
  tool: event.tool_name,
  command: event.tool_input?.command ?? event.tool_input?.cmd,
  path: event.tool_input?.path,
  source: await snapshotSource({ root: workspace }),
  startedAt: new Date().toISOString(),
  exitCode: result?.exit_code,
  stdout: result?.output,
}) + "\n", { mode: 0o600 });
process.stdout.write("{}\n");
