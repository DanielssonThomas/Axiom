import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { assembleBundles, writeBundles, type BundleAdapter, type BundleFile, type BundleInput, type WrittenBundle } from "@axiom/bundles";
import { policyPaths, runtimeFile, type RuntimeManifest } from "./runtime.js";

export const marketplace = "axiom-local";
export const pluginId = `axiom@${marketplace}`;
export const supportedVersion = "2.1.330";
const runtimeRoot = "plugins/axiom";
const hookRuntime = "hooks/axiom.mjs";

export interface ClaudeBundle extends WrittenBundle {
  plugin: string;
}

export interface ClaudeBundleInput extends Omit<BundleInput, "adapters"> {
  repository: string;
  destination: string;
}

function json(path: string, value: unknown): BundleFile {
  return { path, text: JSON.stringify(value, null, 2) + "\n" };
}

async function compileHook(): Promise<string> {
  const compiled = fileURLToPath(new URL("./hook.js", import.meta.url));
  const input = await access(compiled).then(() => compiled, () => fileURLToPath(new URL("./hook.ts", import.meta.url)));
  const bundle = await rolldown({ input, platform: "node" });
  try {
    const { output } = await bundle.generate({ format: "esm", codeSplitting: false });
    const chunk = output[0];
    if (output.length !== 1 || !chunk || chunk.type !== "chunk") throw new Error("Expected a self-contained native hook.");
    return chunk.code;
  } finally {
    await bundle.close();
  }
}

/** Use the single bundle assembler for canonical policy, inventory, skills, and native files. */
export async function buildClaudeBundle(input: ClaudeBundleInput): Promise<ClaudeBundle> {
  const { repository, destination, ...request } = input;
  const hookCode = await compileHook();
  const hooksFor = (policy: RuntimeManifest["policy"]) => policyPaths(policy).map((path) => ({
    type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/" + hookRuntime, path], timeout: 10,
  }));
  const adapter = (inventory?: RuntimeManifest): BundleAdapter => ({
    host: "claude", runtimeRoot, fixture: false, requiredCapabilities: ["native-package"],
    capabilities: [{ id: "native-package", available: true }],
    nativeFiles: ({ version, policy }) => [
      json(".claude-plugin/marketplace.json", {
        name: marketplace, owner: { name: "Axiom" }, description: "Local Axiom native packages.",
        plugins: [{ name: "axiom", source: `./${runtimeRoot}`, version, description: "Axiom engineering workflows." }],
      }),
      json(`${runtimeRoot}/.claude-plugin/plugin.json`, {
        name: "axiom", version, author: { name: "Axiom" }, description: "Axiom engineering workflows.",
        metadata: { policyDigest: policy.digest }, engines: { "claude-code": supportedVersion },
      }),
      json(`${runtimeRoot}/hooks/hooks.json`, {
        hooks: { SessionStart: [{ matcher: "startup", hooks: hooksFor(policy) }], SubagentStart: [{ hooks: hooksFor(policy) }] },
      }),
      { path: `${runtimeRoot}/${hookRuntime}`, text: hookCode },
      ...(inventory ? [json(`${runtimeRoot}/${runtimeFile}`, inventory)] : []),
    ],
  });
  const preliminary = assembleBundles(repository, { ...request, adapters: [adapter()] })[0]!;
  const inventory = {
    policy: preliminary.manifest.policy,
    files: preliminary.manifest.files.filter(({ path }) => path.startsWith(`${runtimeRoot}/`))
      .map(({ path, digest }) => ({ path: path.slice(runtimeRoot.length + 1), digest })),
  };
  const final = assembleBundles(repository, { ...request, adapters: [adapter(inventory)] })[0]!;
  const withoutInventory = final.manifest.files.filter(({ path }) => path !== `${runtimeRoot}/${runtimeFile}`);
  if (JSON.stringify(withoutInventory) !== JSON.stringify(preliminary.manifest.files)) {
    throw new Error("Canonical native bundle inputs changed during assembly.");
  }
  const written = (await writeBundles(destination, [final]))[0]!;
  return { ...written, plugin: join(written.directory, runtimeRoot) };
}
