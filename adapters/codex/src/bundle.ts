import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PolicyIdentity } from "@axiom/contracts";
import { resolvePolicy, type PolicyCatalog } from "@axiom/policy";

export const marketplace = "axiom-local";
export const pluginId = `axiom@${marketplace}`;
const pluginPath = "plugins/axiom";
const startMarker = "<!-- Axiom Codex policy begin -->";
const endMarker = "<!-- Axiom Codex policy end -->";
const begin = `\n\n${startMarker}\n`;
const end = `\n${endMarker}\n`;

export interface CodexBundle {
  root: string;
  version: string;
  policy: PolicyIdentity;
  skills: readonly string[];
  instructions: string;
}

export interface CodexBundleInput {
  source: string;
  destination: string;
  version: string;
  catalog: PolicyCatalog;
  profiles: readonly string[];
}

export function digest(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function write(path: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Build the documented local marketplace and native compatibility manifest from canonical files. */
export async function buildCodexBundle(input: CodexBundleInput): Promise<CodexBundle> {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(input.version)) throw new Error("Expected a native plugin version.");
  const resolution = resolvePolicy(input.catalog, input.profiles);
  if (!resolution.policy || resolution.diagnostics.length > 0) throw new Error("Could not resolve canonical Axiom policy.");
  const policy = resolution.policy.identity;
  const source = resolve(input.source);
  const root = resolve(input.destination);
  const plugin = join(root, pluginPath);
  const entries = (await readdir(join(source, "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
  const skills: Record<string, string> = Object.create(null);
  const contents: { name: string; bytes: Buffer }[] = [];
  for (const name of entries) {
    const skill = join(source, "skills", name, "SKILL.md");
    const info = await lstat(skill).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!info) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !info.isFile()) throw new Error("Unsupported canonical skill path.");
    const bytes = await readFile(skill);
    skills[name] = digest(bytes);
    contents.push({ name, bytes });
  }
  if (contents.length === 0) throw new Error("No canonical skills were found.");

  const profiles = await Promise.all(policy.profiles.map(({ id }) =>
    readFile(join(source, "profiles", id, "PROFILE.md"), "utf8")));
  const policyBody = [input.catalog.core.text, ...profiles].map((document) =>
    document.replaceAll("\r\n", "\n").trimEnd()).join("\n\n");
  const instructions = `Axiom policy digest: ${policy.digest}\n\n${policyBody}`;
  if (instructions.includes(startMarker) || instructions.includes(endMarker)) throw new Error("Axiom content contains a reserved profile marker.");

  await mkdir(root, { recursive: true });
  if ((await readdir(root)).length > 0) throw new Error("The native bundle destination must be empty.");
  await write(join(root, ".agents/plugins/marketplace.json"), json({
    name: marketplace,
    interface: { displayName: "Axiom" },
    plugins: [{
      name: "axiom", source: { source: "local", path: `./${pluginPath}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    }],
  }));
  await write(join(plugin, ".codex-plugin/plugin.json"), json({
    name: "axiom", version: input.version, description: "Axiom engineering workflows.", skills: "./skills/",
  }));
  for (const { name, bytes } of contents) await write(join(plugin, "skills", name, "SKILL.md"), bytes);
  await write(join(plugin, "axiom-policy.json"), json({ policy, instructionsDigest: digest(instructions), skills }));
  await write(join(plugin, "axiom-policy.txt"), instructions + "\n");
  return { root, version: input.version, policy, skills: contents.map(({ name }) => name), instructions };
}

/** Insert/replace/remove only the adapter-owned fragment, retaining unrelated bytes. */
export function transformProfileInstructions(existing: string, instructions?: string): string {
  const from = existing.indexOf(begin);
  const to = existing.indexOf(end);
  if ((from === -1) !== (to === -1) || (from !== -1 &&
    (to < from || existing.indexOf(begin, from + begin.length) !== -1 || existing.indexOf(end, to + end.length) !== -1))) {
    throw new Error("The profile contains an invalid or repeated Axiom instruction fragment.");
  }
  const fragment = instructions === undefined ? "" : `${begin}${instructions}${end}`;
  return from === -1 ? existing + fragment : existing.slice(0, from) + fragment + existing.slice(to + end.length);
}

/** Retain only adapter-owned policy text from the model-visible instruction layer. */
export function observedPolicyFragments(context: string): string[] {
  const contents = context.replaceAll("\r\n", "\n");
  const open = `${startMarker}\n`;
  const close = `\n${endMarker}`;
  const fragments: string[] = [];
  let offset = 0;
  while (offset < contents.length) {
    const from = contents.indexOf(open, offset);
    if (from === -1) break;
    const start = from + open.length;
    const finish = contents.indexOf(close, start);
    if (finish === -1) break;
    fragments.push(contents.slice(start, finish));
    offset = finish + close.length;
  }
  return fragments;
}
