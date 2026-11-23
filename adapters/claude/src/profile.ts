import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { marketplace, pluginId, supportedVersion, type ClaudeBundle } from "./bundle.js";
import { claudeVersion, nativeJson, type ClaudeProfile } from "./process.js";
import { array, object } from "./runtime.js";

export type ClaudeScope = "local" | "project" | "user";
export type ClaudeLifecycle = "install" | "update" | "disable" | "uninstall";

async function pluginInventory(profile: ClaudeProfile, signal?: AbortSignal) {
  return array(await nativeJson(profile, ["plugin", "list"], signal)).map(object);
}

async function installedPlugin(profile: ClaudeProfile, scope: ClaudeScope, signal?: AbortSignal) {
  const workspace = await realpath(profile.workspace);
  return (await pluginInventory(profile, signal)).find((plugin) => plugin.id === pluginId && plugin.scope === scope
    && (scope === "user" || plugin.projectPath === workspace));
}

export async function observeClaudeInstallation(profile: ClaudeProfile, scope: ClaudeScope, signal?: AbortSignal) {
  const observedVersion = await claudeVersion(profile, signal);
  const plugin = observedVersion === supportedVersion ? await installedPlugin(profile, scope, signal) : undefined;
  return { discovered: plugin !== undefined, selected: plugin?.enabled === true, ...(observedVersion ? { observedVersion } : {}) };
}

export async function validateClaudeBundle(profile: ClaudeProfile, bundle: ClaudeBundle, signal?: AbortSignal): Promise<readonly string[]> {
  if (await claudeVersion(profile, signal) !== supportedVersion) throw new Error("This Claude Code version is unsupported.");
  await nativeJson(profile, ["plugin", "validate", bundle.directory, "--strict"], signal);
  const native = object(await nativeJson(profile, ["plugin", "validate", bundle.plugin, "--strict"], signal));
  const skills = array(object(native.provides).skills).filter((name): name is string => typeof name === "string");
  if (native.success !== true || !bundle.manifest.skills.every(({ id }) => skills.includes(`axiom:${id}`))) {
    throw new Error("Claude did not validate the native plugin and canonical skills.");
  }
  return skills;
}

async function stage(source: string, destination: string, state: string) {
  const temporary = join(state, `new-${randomUUID()}`);
  const original = join(state, `old-${randomUUID()}`);
  let backedUp = false;
  try {
    await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
    await rename(destination, original).then(() => { backedUp = true; }, (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (backedUp) await rename(original, destination);
      throw error;
    }
    if (backedUp) await rm(original, { recursive: true, force: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Apply native settings only at the selected scope. The shared local marketplace remains registered. */
export async function configureClaudeProfile(
  profile: ClaudeProfile, scope: ClaudeScope, action: ClaudeLifecycle, bundle?: ClaudeBundle,
  signal = AbortSignal.timeout(45_000),
): Promise<void> {
  signal.throwIfAborted();
  if (scope !== "user" && scope !== "project" && scope !== "local") throw new Error("Unknown native Claude settings scope.");
  if (process.platform !== "linux" || await claudeVersion(profile, signal) !== supportedVersion) {
    throw new Error("This Claude Code CLI platform or version is unsupported.");
  }
  const state = join(await realpath(profile.home), "axiom-claude");
  const destination = join(state, "marketplace");
  const selected = await installedPlugin(profile, scope, signal);
  if (!selected && (action === "disable" || action === "uninstall")) return;
  const marketplaces = array(await nativeJson(profile, ["plugin", "marketplace", "list"], signal)).map(object);
  const existing = marketplaces.find(({ name }) => name === marketplace);
  if ((existing && existing.path !== destination) || (selected && !existing)) {
    throw new Error("The Axiom marketplace name is bound to a different source.");
  }
  if (action === "disable" || action === "uninstall") {
    if (selected && (action === "uninstall" || selected.enabled === true)) {
      await nativeJson(profile, ["plugin", action, pluginId, "--scope", scope], signal);
    }
    return;
  }
  if (!bundle) throw new Error("Select a native Claude bundle before installing or updating.");
  await mkdir(state, { recursive: true });
  if (!(await lstat(state)).isDirectory()) throw new Error("The Claude adapter state directory is invalid.");
  const lock = join(state, "operation");
  await mkdir(lock);
  try {
    await validateClaudeBundle(profile, bundle, signal);
    await stage(bundle.directory, destination, state);
    if (!existing) await nativeJson(profile, ["plugin", "marketplace", "add", destination], signal);
    if (selected && action === "update") {
      await nativeJson(profile, ["plugin", "marketplace", "update", marketplace], signal);
      await nativeJson(profile, ["plugin", "update", pluginId, "--scope", scope], signal);
    } else if (!selected) {
      await nativeJson(profile, ["plugin", "install", pluginId, "--scope", scope], signal);
    }
    const current = await installedPlugin(profile, scope, signal);
    if (!current || (current.folderVersion !== bundle.manifest.version && current.version !== bundle.manifest.version)) {
      throw new Error("The declared native revision was not observed in the selected scope.");
    }
    const shouldBeEnabled = action === "install" || selected?.enabled !== false;
    if (current.enabled !== shouldBeEnabled) {
      await nativeJson(profile, ["plugin", shouldBeEnabled ? "enable" : "disable", pluginId, "--scope", scope], signal);
    }
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
