import { digestSchema } from "@axiom/contracts";
import type { EvidenceOutcome } from "@axiom/contracts";
import type { BundleAdapter, BundleFile, BundleManifest } from "./model.js";

const metadata = { name: "axiom", description: "Axiom native bundle fixture" };
const marketplace = "axiom-local";
const localPath = "./plugins/axiom";

function json(path: string, value: unknown): BundleFile {
  return { path, text: JSON.stringify(value, null, 2) + "\n" };
}

const fixture = {
  fixture: true,
  requiredCapabilities: ["native-package"],
  capabilities: [{ id: "native-package", available: true }],
} as const;

/** Representative native package layouts for assembly tests, without host behavior claims. */
export const fixtureAdapters: readonly BundleAdapter[] = [
  {
    ...fixture,
    host: "claude",
    runtimeRoot: "plugins/axiom",
    nativeFiles: ({ version }) => [
      json(".claude-plugin/marketplace.json", {
        name: marketplace,
        owner: { name: "Axiom" },
        description: "Axiom native bundle fixtures for packaging verification.",
        plugins: [{ ...metadata, source: localPath, version }],
      }),
      json("plugins/axiom/.claude-plugin/plugin.json", { ...metadata, version, author: { name: "Axiom" } }),
    ],
  },
  {
    ...fixture,
    host: "codex",
    runtimeRoot: "plugins/axiom",
    nativeFiles: ({ version }) => [
      json(".agents/plugins/marketplace.json", {
        name: marketplace,
        interface: { displayName: "Axiom" },
        plugins: [{
          name: metadata.name,
          source: { source: "local", path: localPath },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        }],
      }),
      json("plugins/axiom/.codex-plugin/plugin.json", { ...metadata, version, skills: "./skills/" }),
    ],
  },
  {
    ...fixture,
    host: "hermes",
    runtimeRoot: "",
    nativeFiles: ({ version }) => [
      { path: "plugin.yaml", text: `name: axiom\nversion: ${JSON.stringify(version)}\ndescription: "${metadata.description}"\n` },
      { path: "__init__.py", text: 'def register(ctx):\n    """Provide an entry point for the bundle assembly fixture."""\n' },
    ],
  },
];

interface FixtureConfiguration {
  plugins: Readonly<Record<string, unknown>>;
  [field: string]: unknown;
}

interface FixtureLifecycleResult {
  configuration: FixtureConfiguration;
  outcome: EvidenceOutcome;
}

function isOwned(entry: unknown): entry is Record<string, unknown> & { enabled: boolean; version: string; digest: string } {
  return typeof entry === "object" && entry !== null
    && "owner" in entry && entry.owner === "axiom-bundle-fixture"
    && "enabled" in entry && typeof entry.enabled === "boolean"
    && "version" in entry && typeof entry.version === "string"
    && "digest" in entry && digestSchema.safeParse(entry.digest).success;
}

/** Exercise exact-key ownership in test configuration. Real configuration stays with native adapters. */
export function applyFixtureLifecycle(
  configuration: FixtureConfiguration,
  manifest: BundleManifest,
  operation: "install" | "update" | "disable" | "uninstall",
): FixtureLifecycleResult {
  const success = (configuration: FixtureConfiguration): FixtureLifecycleResult =>
    ({ configuration, outcome: { status: "passed" } });
  const blocked = (reason: string): FixtureLifecycleResult =>
    ({ configuration, outcome: { status: "blocked", reason } });
  if (!manifest.fixture) return blocked("Expected a bundle assembly fixture.");

  const current = configuration.plugins.axiom;
  if (Object.hasOwn(configuration.plugins, "axiom") && !isOwned(current)) {
    return blocked("The Axiom fixture key belongs to an existing unowned entry.");
  }
  if (operation === "uninstall") {
    if (!current) return success(configuration);
    const { axiom: _removed, ...plugins } = configuration.plugins;
    return success({ ...configuration, plugins });
  }
  if (operation !== "install" && !isOwned(current)) return blocked("The Axiom fixture is not installed.");
  if (operation === "disable" && isOwned(current)) {
    return success({ ...configuration, plugins: { ...configuration.plugins, axiom: { ...current, enabled: false } } });
  }
  if (manifest.missingRequirements.length > 0) {
    return blocked(manifest.missingRequirements.map(({ id, reason }) => `${id}: ${reason}`).join(" "));
  }
  if (operation === "install" && isOwned(current) && current.digest !== manifest.digest) {
    return blocked("A different Axiom fixture is installed. Use update.");
  }

  const next = {
    ...(isOwned(current) ? current : { enabled: true }),
    owner: "axiom-bundle-fixture",
    version: manifest.version,
    digest: manifest.digest,
  };
  return success({ ...configuration, plugins: { ...configuration.plugins, axiom: next } });
}
