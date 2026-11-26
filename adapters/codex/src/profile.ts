import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { supportedVersion } from "./activation.js";
import { marketplace, observedPolicyFragments, pluginId, transformProfileInstructions, type CodexBundle } from "./bundle.js";
import { array, nativeJson, nativeVersion, object, runCodex, type CodexProfile } from "./process.js";

export type CodexLifecycle = "install" | "update" | "disable" | "uninstall";

/** The cache subtree exposed by the pinned native plugin skill inventory. */
export function codexInstalledSkillsPath(home: string, version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Expected a native plugin version.");
  return join(home, "plugins", "cache", marketplace, "axiom", version, "skills");
}

export interface NativeCodexObservation {
  observedVersion?: string;
  discovered: boolean;
  selected: boolean;
  contexts: string[];
  skills: string[];
}

async function marketplaceRoot(profile: CodexProfile, signal?: AbortSignal): Promise<string | undefined> {
  const value = object(await nativeJson(profile, ["plugin", "marketplace", "list", "--json"], signal));
  const entry = array(value.marketplaces).map(object).find(({ name }) => name === marketplace);
  return typeof entry?.root === "string" ? entry.root : undefined;
}

async function installedPlugin(profile: CodexProfile, signal?: AbortSignal) {
  const value = object(await nativeJson(profile, ["plugin", "list", "--marketplace", marketplace, "--json", "--available"], signal));
  return array(value.installed).map(object).find((entry) => entry.pluginId === pluginId && entry.installed === true);
}

async function setEnabled(profile: CodexProfile, enabled: boolean, signal: AbortSignal): Promise<void> {
  let wrote = false;
  const { code } = await runCodex(profile, ["app-server", "--stdio"], {
    signal,
    onLine(line, write, end) {
      const message = object(JSON.parse(line));
      if (message.id === 1 && message.result) {
        write({ method: "initialized" });
        write({ id: 2, method: "config/value/write", params: { keyPath: `plugins.${pluginId}.enabled`, value: enabled, mergeStrategy: "replace" } });
      } else if (message.id === 2) {
        const result = object(message.result);
        wrote = result.status === "ok" && result.filePath === join(profile.home, "config.toml");
        end();
      }
    },
  });
  if (!wrote || code !== 0) throw new Error("Codex could not persist the selected plugin setting.");
}

async function regularProfileFile(path: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (info && !info.isFile()) throw new Error("Codex profile settings and instructions must be regular files.");
  return info;
}

async function updateInstructions(profile: CodexProfile, instruction?: string): Promise<void> {
  const file = join(profile.home, "AGENTS.md");
  const info = await regularProfileFile(file);
  const existing = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const updated = transformProfileInstructions(existing, instruction);
  if (updated === existing) return;
  const temporary = join(profile.home, `.axiom-instructions-${randomUUID()}`);
  try {
    await writeFile(temporary, updated, { flag: "wx", mode: info ? info.mode & 0o777 : 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function stageMarketplace(source: string, destination: string, parent: string): Promise<void> {
  const staging = join(parent, `market-${randomUUID()}`);
  const backup = join(parent, `backup-${randomUUID()}`);
  let retainedBackup = false;
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
    await rename(destination, backup).then(() => { retainedBackup = true; }, (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    try {
      await rename(staging, destination);
    } catch (error) {
      if (retainedBackup) {
        await rename(backup, destination);
        retainedBackup = false;
      }
      throw error;
    }
    if (retainedBackup) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Manage only the explicit profile's Axiom marketplace, plugin, and owned instruction fragment. */
export async function configureCodexProfile(
  profile: CodexProfile, action: CodexLifecycle, bundle?: CodexBundle, signal = AbortSignal.timeout(45_000),
): Promise<void> {
  if (!isAbsolute(profile.home) || !isAbsolute(profile.userHome)) throw new Error("Use explicit absolute profile roots.");
  signal.throwIfAborted();
  await mkdir(profile.home, { recursive: true });
  const selected = { ...profile, home: await realpath(profile.home) };
  await Promise.all(["config.toml", "AGENTS.md"].map((name) => regularProfileFile(join(selected.home, name))));
  if (process.platform !== "linux" || await nativeVersion(selected, signal) !== supportedVersion) {
    throw new Error("This Codex CLI version or platform is unsupported.");
  }
  const state = join(selected.home, "axiom-codex");
  await mkdir(state, { recursive: true });
  if (!(await lstat(state)).isDirectory()) throw new Error("The Axiom profile state directory is invalid.");
  const lock = join(state, "operation");
  await mkdir(lock);
  try {
    const destination = join(state, "marketplace");
    const configured = await marketplaceRoot(selected, signal);
    if (configured && resolve(configured) !== destination) throw new Error("The Axiom marketplace name is already used by another source.");
    const installed = configured ? await installedPlugin(selected, signal) : undefined;

    if (action === "disable" || action === "uninstall") {
      if (installed && action === "uninstall") await nativeJson(selected, ["plugin", "remove", pluginId, "--json"], signal);
      if (installed?.enabled === true && action === "disable") await setEnabled(selected, false, signal);
      if (configured && action === "uninstall") {
        await nativeJson(selected, ["plugin", "marketplace", "remove", marketplace, "--json"], signal);
        await rm(destination, { recursive: true, force: true });
      }
      await updateInstructions(selected);
      return;
    }
    if (!bundle) throw new Error("Select the native Axiom bundle before installing or updating.");
    const enabled = action === "install" || !installed || installed.enabled === true;
    await stageMarketplace(bundle.root, destination, state);
    if (!configured) await nativeJson(selected, ["plugin", "marketplace", "add", destination, "--json"], signal);
    await nativeJson(selected, ["plugin", "add", pluginId, "--json"], signal);
    const status = await installedPlugin(selected, signal);
    if (status?.version !== bundle.version) throw new Error("The intended Codex plugin revision was not installed.");
    if (status.enabled !== enabled) await setEnabled(selected, enabled, signal);
    await updateInstructions(selected, enabled ? bundle.instructions : undefined);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function observedPrompt(raw: unknown) {
  const contexts: string[] = [];
  const skills: string[] = [];
  for (const message of array(raw).map(object)) {
    const kinds = array(object(message.internal_chat_message_metadata_passthrough).content_item_kinds);
    for (const [index, item] of array(message.content).map(object).entries()) {
      if (item.type !== "input_text" || typeof item.text !== "string") continue;
      if (message.role === "user" && kinds[index] === "agents_md.instructions") {
        contexts.push(...observedPolicyFragments(item.text));
      }
      if (message.role === "developer" && kinds[index] === "host_skills.instructions") {
        for (const match of item.text.matchAll(/^- (axiom:[a-z][a-z0-9-]*): .*\(file: .*\/SKILL\.md\)$/gm)) {
          if (match[1]) skills.push(match[1]);
        }
      }
    }
  }
  return { contexts, skills };
}

/** Read native installed/enabled state and the actual model-visible prompt layers independently. */
export async function observeCodexProfile(profile: CodexProfile, signal?: AbortSignal): Promise<NativeCodexObservation> {
  const observedVersion = await nativeVersion(profile, signal);
  const empty = { discovered: false, selected: false, contexts: [], skills: [] };
  if (!observedVersion) return empty;
  if (observedVersion !== supportedVersion) return { ...empty, observedVersion };
  const configured = await marketplaceRoot(profile, signal);
  const plugin = configured ? await installedPlugin(profile, signal) : undefined;
  if (!plugin) return { ...empty, observedVersion };
  const prompt = await nativeJson(profile, ["debug", "prompt-input"], signal);
  return { observedVersion, discovered: true, selected: plugin.enabled === true, ...observedPrompt(prompt) };
}
