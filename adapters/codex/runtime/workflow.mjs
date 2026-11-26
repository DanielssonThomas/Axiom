import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const handoff = /^Axiom worker reference: (\.axiom\/[a-zA-Z0-9_-]+\.json) (sha256:[0-9a-f]{64})$/gm;
const fullNodeTest = /\bverification command is `node --test`[.!]?(?:[ \t]|$)/im;
const useFullTest = "Run the documented verification command node --test by itself so the regression and protected acceptance checks run together.";
const prepareBrief = "Read axiom:delegate. Write the complete scoped JSON brief in .axiom/<worker-id>.json and run its SHA-256 as a separate shell call. Include a line Axiom worker reference: <path> sha256:<hex> in the native worker message.";
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

async function assess(event) {
  if (event.hook_event_name !== "PreToolUse") return {};
  const input = event.tool_input;
  if (event.tool_name === "Bash" && typeof input?.command === "string") {
    const command = input.command.trim();
    if (!/^node[ \t]+--test[ \t]+\S/.test(command)) return {};
    const cwd = input.workdir ?? event.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return {};
    const rules = await boundedFile(await realpath(cwd), "AGENTS.md", 128_000).catch(() => undefined);
    return rules && fullNodeTest.test(rules.toString("utf8")) ? deny(useFullTest) : {};
  }
  if (event.tool_name !== "collaborationspawn_agent") return {};
  if (!input || typeof input.message !== "string" || !isAbsolute(event.cwd ?? "")) return deny(prepareBrief);

  const matches = [...input.message.matchAll(handoff)];
  if (matches.length !== 1) return deny(prepareBrief);
  const [, path, expectedDigest] = matches[0];
  try {
    const bytes = await boundedFile(await realpath(event.cwd), path, 16_384);
    if (!bytes || "sha256:" + createHash("sha256").update(bytes).digest("hex") !== expectedDigest) return deny(prepareBrief);
    const brief = JSON.parse(bytes.toString("utf8"));
    const { policy, workerFields } = JSON.parse(await readFile(selectedPolicy, "utf8"));
    if (!brief || !workerFields.every((name) => Object.hasOwn(brief, name)) ||
        typeof brief.parentId !== "string" || !brief.parentId || brief.id === brief.parentId ||
        !isDeepStrictEqual(brief.policy, policy)) return deny(prepareBrief);
  } catch {
    return deny(prepareBrief);
  }
  const firstRead = "Before attempting an edit, run cat -- " + path + " in its own shell call and read the whole brief.";
  const validate = "Check its SHA-256 against " + expectedDigest + ". Apply the brief's ownership, requirements, and limits.";
  return decision({ updatedInput: { ...input, message: input.message + "\n\n" + firstRead + " " + validate } });
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

