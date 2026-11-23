import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function inside(root: string, target: string) {
  const offset = relative(root, target);
  return !isAbsolute(offset) && offset !== ".." && !offset.startsWith(".." + sep);
}

// Hermes calls this through its fail-closed native pre_tool_call hook.
const blocked = { action: "block", message: "This benchmark permits file access only inside its disposable fixture." };
const allowedFiles = new Set(["read_file", "write_file", "search_files"]);

async function guard(workspace: string, event: { tool_name?: string; tool_input?: Record<string, unknown> }) {
  const tool = event.tool_name;
  const input = event.tool_input ?? {};
  if (tool === "skills_list") return {};
  if (tool === "skill_view" && typeof input.name === "string" && /^axiom:[a-z-]+$/.test(input.name) &&
      (input.file_path === undefined || input.file_path === "PROFILE.md")) return {};
  if (!tool || !allowedFiles.has(tool)) return blocked;
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

let text = "";
try {
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 1024 * 1024) throw new Error("Tool input too large.");
  }
  const workspace = await realpath(process.argv[2]!);
  console.log(JSON.stringify(await guard(workspace, JSON.parse(text))));
} catch {
  console.log(JSON.stringify(blocked));
}
