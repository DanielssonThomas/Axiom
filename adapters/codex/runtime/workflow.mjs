import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const taskName = /^[a-z0-9][a-z0-9_]{0,127}$/;
const hashCommand = /^sha256sum(?: --)? (\.axiom\/[a-z0-9][a-z0-9_]{0,127}\.json)$/;
const fullNodeTest = /\bverification command is `node --test`[.!]?(?:[ \t]|$)/im;
const useFullTest = "Run the documented verification command node --test by itself so the regression and protected acceptance checks run together.";
const prepareBrief = "Save the canonical Axiom task brief at .axiom/<task_name>.json. "
  + "Match the brief id, file stem, and native task_name. Run sha256sum -- on the file as a separate shell call. "
  + "Give the worker the path and digest in the native handoff. Its first shell call must be cat -- on that file.";
const selectedPolicy = new URL("../axiom-policy.json", import.meta.url);

function decision(fields) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } };
}

function deny(reason) {
  return decision({ permissionDecision: "deny", permissionDecisionReason: reason });
}

async function boundedFile(root, path, limit) {
  const file = join(root, path);
  const entry = await lstat(file).catch(() => undefined);
  if (!entry?.isFile() || entry.size > limit || await realpath(file) !== file) return;
  const bytes = await readFile(file);
  if (bytes.length <= limit) return bytes;
}

async function briefProblem(cwd, path) {
  try {
    const bytes = await boundedFile(await realpath(cwd), path, 16_384);
    if (!bytes) return prepareBrief;
    const brief = JSON.parse(bytes.toString("utf8"));
    const { policy, workerFields, workerCapabilityPattern } = JSON.parse(await readFile(selectedPolicy, "utf8"));
    if (!brief || Object.keys(brief).length !== workerFields.length || !workerFields.every((name) => Object.hasOwn(brief, name))) {
      return "Use exactly these Axiom task brief fields: " + workerFields.join(", ")
        + ". Put supplemental task details inside objective or the native worker message.";
    }
    const capability = new RegExp(workerCapabilityPattern);
    if (!Array.isArray(brief.requiredCapabilities)
        || brief.requiredCapabilities.some((id) => typeof id !== "string" || !capability.test(id))) {
      return "Use canonical capability IDs in requiredCapabilities. Use process-execution for running verification commands.";
    }
    if (typeof brief.parentId !== "string" || !brief.parentId || brief.id === brief.parentId ||
        path !== ".axiom/" + brief.id + ".json" || !isDeepStrictEqual(brief.policy, policy)) return prepareBrief;
  } catch {
    return prepareBrief;
  }
}

async function assess(event) {
  if (event.hook_event_name !== "PreToolUse") return {};
  const input = event.tool_input;
  if (event.tool_name === "Bash" && typeof input?.command === "string") {
    const command = input.command.trim();
    const cwd = input.workdir ?? event.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return {};
    const reference = hashCommand.exec(command)?.[1];
    if (reference) {
      const problem = await briefProblem(cwd, reference);
      return problem ? deny(problem) : {};
    }
    if (!/^node[ \t]+--test[ \t]+\S/.test(command)) return {};
    const rules = await boundedFile(await realpath(cwd), "AGENTS.md", 128_000).catch(() => undefined);
    return rules && fullNodeTest.test(rules.toString("utf8")) ? deny(useFullTest) : {};
  }
  if (event.tool_name !== "collaborationspawn_agent") return {};
  if (typeof input?.task_name !== "string" || !taskName.test(input.task_name) || !isAbsolute(event.cwd ?? "")) {
    return deny(prepareBrief);
  }
  // The hosted V2 worker message is opaque. Only use the separately staged brief.
  const problem = await briefProblem(event.cwd, ".axiom/" + input.task_name + ".json");
  return problem ? deny(problem) : {};
}

process.stdin.setEncoding("utf8");
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 256_000) break;
}
try {
  process.stdout.write(JSON.stringify(raw.length <= 256_000 ? await assess(JSON.parse(raw)) : {}) + "\n");
} catch {
  process.stdout.write("{}\n");
}

