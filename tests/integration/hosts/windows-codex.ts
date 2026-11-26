import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { marketplace, pluginId, transformProfileInstructions, type CodexBundle } from "../../../adapters/codex/src/bundle.js";
import { array, nativeJson, object, runCodex, type CodexProfile } from "../../../adapters/codex/src/process.js";

export const windowsSandbox = '[windows]\nsandbox = "unelevated"\nallow_mxc = false\n';

export function windowsCodexEnvironment(userHome: string): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries({ SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
    USERPROFILE: userHome, APPDATA: userHome, LOCALAPPDATA: userHome, TEMP: userHome, TMP: userHome,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

// Exercise Codex's native interfaces in disposable fixtures while the supported Axiom installer stays Linux-only.
export function windowsCodexFixture(profile: CodexProfile, root: string, signal: AbortSignal) {
  const destination = join(root, "marketplace");
  const invoke = (args: string[]) => nativeJson(profile, ["plugin", ...args, "--json"], signal);
  const installed = async () => {
    const state = object(await invoke(["list", "--marketplace", marketplace, "--available"]));
    return array(state.installed).map(object).find((item) => item.pluginId === pluginId && item.installed === true);
  };
  const instructions = async (policy?: string) => {
    const file = join(profile.home, "AGENTS.md");
    const existing = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    await writeFile(file, transformProfileInstructions(existing, policy));
  };
  return {
    installed,
    async install(bundle: CodexBundle, update = false) {
      if (update) await rm(destination, { recursive: true });
      await cp(bundle.root, destination, { recursive: true });
      if (!update) await invoke(["marketplace", "add", destination]);
      await invoke(["add", pluginId]);
      const selected = await installed();
      if (selected?.version !== bundle.version || selected.enabled !== true) {
        throw new Error("The selected Windows Codex plugin version was not enabled.");
      }
      await instructions(bundle.instructions);
    },
    async disable() {
      let acknowledged = false;
      const { code } = await runCodex(profile, ["app-server", "--stdio"], {
        signal,
        onLine(line, write, end) {
          const message = object(JSON.parse(line));
          if (message.id === 1 && message.result) {
            write({ method: "initialized" });
            write({ id: 2, method: "config/value/write", params: { keyPath: `plugins.${pluginId}.enabled`, value: false,
              mergeStrategy: "replace" } });
          } else if (message.id === 2) {
            acknowledged = object(message.result).status === "ok";
            end();
          }
        },
      });
      if (!acknowledged || code !== 0 || (await installed())?.enabled !== false) {
        throw new Error("Windows Codex did not persist the disabled profile setting.");
      }
      await instructions();
    },
    async uninstall() {
      await invoke(["remove", pluginId]);
      await invoke(["marketplace", "remove", marketplace]);
      const configured = object(await invoke(["marketplace", "list"]));
      if (array(configured.marketplaces).map(object).some(({ name }) => name === marketplace)) {
        throw new Error("Windows Codex still lists the removed marketplace.");
      }
      await instructions();
    },
  };
}
