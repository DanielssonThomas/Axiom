import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { devNull, homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { assembleBundles, loadBundleWorkspace, writeBundles, type BundleHost } from "@axiom/bundles";
import { buildClaudeBundle, supportedVersion as claudeVersion } from "@axiom/claude-adapter";
import { buildCodexBundle, configureCodexProfile, supportedVersion as codexVersion, type CodexBundle, type CodexLifecycle } from "@axiom/codex-adapter";
import { digestSchema, policyIdentitySchema, profileIdSchema, type EvidenceOutcome, type PolicyIdentity } from "@axiom/contracts";
import { hermesBundleAdapter, hermesVersion } from "@axiom/hermes-adapter";

const execute = promisify(execFile);
const sourcePaths = ["core", "profiles", "skills", "LICENSE", "adapters", "packages", "package.json",
  "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "tsconfig.build.json", "tsconfig.json"];
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/;

interface NativeDistribution {
  schemaVersion: 1;
  version: string;
  sourceRevision: string;
  policy: PolicyIdentity;
  hosts: Record<BundleHost, { directory: string; hostVersion: string; digest: string }> & { hermes: { commit: string } };
}

type NativeResult<T> = { outcome: EvidenceOutcome; report?: T };

function blocked(error: unknown): { outcome: EvidenceOutcome } {
  return { outcome: { status: "blocked", reason: error instanceof Error ? error.message : "The native operation was unavailable." } };
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const digest = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function readJson(file: string | URL) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error("Native bundle metadata is missing or invalid.");
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const environment = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Axiom", GIT_AUTHOR_EMAIL: "bundle@axiom.invalid",
    GIT_COMMITTER_NAME: "Axiom", GIT_COMMITTER_EMAIL: "bundle@axiom.invalid", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  try {
    return (await execute("git", [...args], { cwd, env: environment, timeout: 15_000, windowsHide: true })).stdout.trim();
  } catch {
    throw new Error("Git could not inspect the checkout or prepare the native artifact.");
  }
}

async function reviewedRevision(repository: string): Promise<string> {
  const root = await git(repository, ["rev-parse", "--show-toplevel"]);
  if (await realpath(root) !== repository) throw new Error("Use the root of the reviewed Axiom checkout.");
  if (await git(repository, ["status", "--porcelain", "--untracked-files=all", "--", ...sourcePaths])) {
    throw new Error("Commit or discard uncommitted bundle source changes before staging a pinned distribution.");
  }
  return git(repository, ["rev-parse", "--verify", "HEAD"]);
}

async function codexDigest(directory: string): Promise<string> {
  if (!(await lstat(directory)).isDirectory()) throw new Error("Expected a regular native Codex artifact directory.");
  const files: Record<string, string> = Object.create(null);
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) throw new Error("A native Codex artifact contains an unsupported file.");
    const path = join(entry.parentPath, entry.name);
    files[relative(directory, path).split(sep).join("/")] = digest(await readFile(path));
  }
  return digest(JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}

async function hermesGitSource(directory: string, artifact: string, version: string): Promise<string> {
  await mkdir(directory);
  await git(directory, ["init", "--bare", "--object-format=sha1", "--template=", "--initial-branch=main", "--quiet"]);
  await git(directory, ["-c", "core.autocrlf=false", "-c", "core.filemode=false", "--work-tree", artifact, "add", "--all", "--force"]);
  const tree = await git(directory, ["write-tree"]);
  const commit = await git(directory, ["-c", "commit.gpgSign=false", "commit-tree", tree, "-m", `Axiom native Hermes bundle ${version}`]);
  await git(directory, ["update-ref", "refs/heads/main", commit]);
  await rm(join(directory, "index"));
  return commit;
}

export async function runNativeBundle(options: { repository: string; output: string; version?: string; profiles?: readonly string[] }):
Promise<NativeResult<NativeDistribution & { directory: string; hermesUrl: string }>> {
  let temporary: string | undefined;
  try {
    const version = options.version ?? (await readJson(new URL("../package.json", import.meta.url))).version;
    if (typeof version !== "string" || version.length > 128 || !versionPattern.test(version)) {
      throw new Error("Choose a numeric plugin version, optionally with a prerelease suffix.");
    }
    const profiles = profileIdSchema.array().parse(options.profiles ?? []);
    const output = resolve(options.output);
    if (await lstat(output).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    })) throw new Error("Choose a new native distribution directory.");
    const repository = await realpath(options.repository);
    const sourceRevision = await reviewedRevision(repository);
    const { catalog, skills } = loadBundleWorkspace(repository);
    await mkdir(dirname(output), { recursive: true });
    temporary = await mkdtemp(join(dirname(output), ".axiom-native-"));
    const artifacts = join(temporary, ".artifacts");
    const input = { version, sourceRevision, policyVersion: catalog.core.version, selectedProfiles: profiles, skills, checks: catalog.checks };
    const claude = await buildClaudeBundle({ ...input, repository, destination: artifacts });
    const [hermes] = writeBundles(artifacts, assembleBundles(repository, { ...input, adapters: [hermesBundleAdapter] }));
    if (!hermes) throw new Error("The Hermes artifact was not assembled.");
    const codex = await buildCodexBundle({ version, source: repository, destination: join(temporary, "codex"), catalog, profiles });
    const policy = claude.manifest.policy;
    if (codex.policy.digest !== policy.digest || hermes.manifest.policy.digest !== policy.digest) {
      throw new Error("Native artifacts did not resolve the same effective policy.");
    }
    await cp(join(claude.plugin, "LICENSE"), join(codex.root, "plugins/axiom/LICENSE"));
    await rename(claude.directory, join(temporary, "claude"));
    const commit = await hermesGitSource(join(temporary, "hermes"), hermes.directory, version);
    const manifest: NativeDistribution = {
      schemaVersion: 1, version, sourceRevision, policy,
      hosts: {
        claude: { directory: "claude", hostVersion: claudeVersion, digest: claude.manifest.digest },
        codex: { directory: "codex", hostVersion: codexVersion, digest: await codexDigest(codex.root) },
        hermes: { directory: "hermes", hostVersion: hermesVersion, digest: hermes.manifest.digest, commit },
      },
    };
    await rm(artifacts, { recursive: true });
    await writeFile(join(temporary, "axiom-distribution.json"), json(manifest), { flag: "wx" });
    if (await reviewedRevision(repository) !== sourceRevision) throw new Error("The bundle source revision changed during staging.");
    await rename(temporary, output);
    temporary = undefined;
    return { outcome: { status: "passed" }, report: {
      ...manifest, directory: output, hermesUrl: pathToFileURL(join(output, "hermes")).href,
    } };
  } catch (error) {
    return blocked(error);
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

async function readStagedCodexBundle(distribution: string): Promise<CodexBundle> {
  const directory = await realpath(distribution);
  const manifest = await readJson(join(directory, "axiom-distribution.json"));
  const native = manifest?.hosts?.codex;
  const root = join(directory, "codex");
  if (manifest?.schemaVersion !== 1 || native?.directory !== "codex" || native.hostVersion !== codexVersion ||
      typeof manifest.version !== "string" || !versionPattern.test(manifest.version) ||
      digestSchema.parse(native.digest) !== await codexDigest(root)) {
    throw new Error("The staged Codex artifact failed its version and digest checks.");
  }
  const plugin = join(root, "plugins", "axiom");
  const metadata = await readJson(join(plugin, "axiom-policy.json"));
  const policy = policyIdentitySchema.parse(metadata.policy);
  const instructions = (await readFile(join(plugin, "axiom-policy.txt"), "utf8")).replace(/\n$/, "");
  if (policy.digest !== policyIdentitySchema.parse(manifest.policy).digest || digest(instructions) !== metadata.instructionsDigest) {
    throw new Error("The staged Codex policy digest does not match its artifact.");
  }
  return { root, version: manifest.version, policy, instructions, skills: Object.keys(metadata.skills).sort() };
}

async function codexProgram(explicit?: string): Promise<string> {
  if (explicit) return realpath(resolve(explicit));
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    const candidate = join(directory, "codex");
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return realpath(candidate);
  }
  throw new Error("Codex is unavailable on PATH. Supply the path to the pinned executable.");
}

export async function runCodexLifecycle(options: {
  action: CodexLifecycle;
  distribution?: string;
  program?: string;
  home?: string;
  userHome?: string;
  workspace?: string;
}):
Promise<NativeResult<{ host: "codex"; action: CodexLifecycle; version?: string }>> {
  try {
    const { action, distribution } = options;
    const requiresArtifact = action === "install" || action === "update";
    if (requiresArtifact && !distribution) throw new Error("Supply a staged native distribution for Codex installation or update.");
    const bundle = requiresArtifact ? await readStagedCodexBundle(distribution!) : undefined;
    const userHome = resolve(options.userHome ?? homedir());
    const home = resolve(options.home ?? process.env.CODEX_HOME ?? join(userHome, ".codex"));
    await configureCodexProfile({ home, workspace: resolve(options.workspace ?? process.cwd()), userHome,
      program: await codexProgram(options.program) }, action, bundle);
    return { outcome: { status: "passed" }, report: { host: "codex", action, ...(bundle ? { version: bundle.version } : {}) } };
  } catch (error) {
    return blocked(error);
  }
}
