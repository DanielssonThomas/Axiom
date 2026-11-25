import { appendFile, lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";

function inside(root: string, target: string) {
  const offset = relative(root, target);
  return !isAbsolute(offset) && offset !== ".." && !offset.startsWith(".." + sep);
}

// Hermes calls this through its fail-closed native pre_tool_call hook.
const blocked = { action: "block", message: "This benchmark permits file access only inside its disposable fixture." };
const allowedFiles = new Set(["read_file", "write_file", "search_files", "patch"]);
const edits = new Set(["write_file", "patch"]);
interface HookEvent {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  extra?: { tool_call_id?: string };
}

async function guard(workspace: string, event: HookEvent) {
  const tool = event.tool_name;
  const input = event.tool_input ?? {};
  if (tool === "skills_list") return {};
  if (tool === "skill_view" && typeof input.name === "string" && /^axiom:[a-z-]+$/.test(input.name) &&
      (input.file_path === undefined || input.file_path === "PROFILE.md")) return {};
  if (!tool || !allowedFiles.has(tool)) return blocked;
  if (tool === "patch") {
    if (input.mode === "patch") {
      // Hermes checks every V4A edit target with its native parser and safe-root policy.
      const nativeRoot = process.env.HERMES_WRITE_SAFE_ROOT;
      if (nativeRoot !== workspace || workspace.includes(delimiter) || typeof input.patch !== "string" || !input.patch.trim()) return blocked;
      return {};
    }
    if (input.mode !== undefined && input.mode !== "replace") return blocked;
  }
  const path = input.path ?? (tool === "search_files" ? "." : undefined);
  if (typeof path !== "string" || !path.trim()) return blocked;
  const target = resolve(workspace, path);
  if (!inside(workspace, target)) return blocked;
  let ancestor = target;
  while (true) {
    try {
      // A dangling symlink is still a symlink and must never be accepted for write_file.
      await lstat(ancestor);
      if (!inside(workspace, await realpath(ancestor))) return blocked;
      return { action: "modify", args: { path: target } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || ancestor === workspace) return blocked;
      ancestor = resolve(ancestor, "..");
    }
  }
}

async function clarificationGuard(workspace: string, observation: string, event: HookEvent) {
  const { tool_name: tool, extra } = event;
  if (tool === "clarify") return {};
  const editing = typeof tool === "string" && edits.has(tool);
  const verdict = editing ? blocked : await guard(workspace, event);
  const issueRead = tool === "read_file" && "args" in verdict && verdict.args?.path === resolve(workspace, "issue.txt");
  if (editing || issueRead) {
    const id = extra?.tool_call_id;
    if (typeof id !== "string" || !/^[\w.:/-]{1,160}$/.test(id)) return blocked;
    await appendFile(observation, JSON.stringify({ id, kind: editing ? "edit" : "read", tool }) + "\n");
  }
  return verdict;
}

let text = "";
try {
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 1024 * 1024) throw new Error("Tool input too large.");
  }
  const workspace = await realpath(process.argv[2]!);
  const observation = process.argv[3];
  const event: HookEvent = JSON.parse(text);
  console.log(JSON.stringify(await (observation ? clarificationGuard(workspace, observation, event) : guard(workspace, event))));
} catch {
  console.log(JSON.stringify(blocked));
}
