import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { sourceIdentitySchema, type SourceIdentity } from "@axiom/contracts";
import { digestFile, isMissing, isWithin, portablePath, relativePath } from "./paths.js";

export interface SourceScope {
  root: string;
  /** Literal paths relative to root. Omit to include the entire Git checkout scope. */
  paths?: readonly string[];
  /** Additional literal files, including ignored configuration when relevant. */
  extraFiles?: readonly string[];
  /** Generated outputs to omit from the relevant source/configuration. */
  excludedPaths?: readonly string[];
}

const exec = promisify(execFile);
const gitOptions = { maxBuffer: 32 * 1024 * 1024, encoding: "buffer" } as const;

async function readRevision(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root, ...gitOptions });
    return stdout.toString().trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return undefined; // Unborn branch.
    throw error;
  }
}

async function symlinkIdentity(root: string, name: string, path: string, exclusions: readonly string[]): Promise<readonly unknown[]> {
  const target = await realpath(path).catch(() => {
    throw new Error("The source symlink target could not be resolved.");
  });
  if (!isWithin(root, target)) throw new Error("The source symlink target is outside the checkout.");
  const relativeTarget = portablePath(relative(root, target));
  if (matches(relativeTarget, ".git") || exclusions.some((entry) => matches(relativeTarget, entry))) {
    throw new Error("The source symlink target is outside the permitted source scope.");
  }
  const info = await stat(target);
  if (!info.isFile()) throw new Error("The source symlink target must be a regular file.");
  return [name, "symlink", await readlink(path), relativeTarget, Boolean(info.mode & 0o111), await digestFile(target)];
}

async function fileIdentity(root: string, name: string, expectFile: boolean, exclusions: readonly string[]): Promise<readonly unknown[]> {
  const path = join(root, name);
  try {
    const info = await lstat(path);
    // Git can retain nested entries whose parent is now a symlink in the working tree.
    const parent = await realpath(join(path, ".."));
    if (!isWithin(root, parent)) throw new Error("Source path resolves outside the checkout.");
    if (info.isSymbolicLink()) return symlinkIdentity(root, name, path, exclusions);
    if (info.isFile()) return [name, "file", Boolean(info.mode & 0o111), await digestFile(path)];
    // An indexed file may have been replaced with a directory whose untracked files
    // are enumerated separately. Other node types have no reproducible file content.
    if (info.isDirectory() && !expectFile) return [name, "directory"];
    throw new Error("Source path is not a file, directory, or symbolic link.");
  } catch (error) {
    if (isMissing(error)) return [name, "missing"];
    throw error;
  }
}

function normalizedScope(paths: readonly string[] = []): string[] {
  return [...new Set(paths.map(relativePath))].sort();
}

function matches(path: string, entry: string): boolean {
  return path === entry || path.startsWith(`${entry}/`);
}

/**
 * Snapshot tracked and nonignored untracked working-tree content. Selected links
 * also bind the content of their regular file targets within the checkout.
 * External, excluded, directory, and unresolved link targets prevent a snapshot.
 */
export async function snapshotSource(scope: SourceScope): Promise<SourceIdentity> {
  const root = await realpath(scope.root);
  const paths = normalizedScope(scope.paths);
  const exclusions = normalizedScope(scope.excludedPaths);
  const extraFiles = new Set(normalizedScope(scope.extraFiles));
  const args = ["--literal-pathspecs", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths];
  const { stdout } = await exec("git", args, { cwd: root, ...gitOptions });
  const revision = await readRevision(root);
  const names = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout).split("\0");
  const files = [...new Set([...names, ...extraFiles])].filter((name) => name && !exclusions.some((path) => matches(name, path))).sort();
  const hash = createHash("sha256").update(JSON.stringify([paths, exclusions, [...extraFiles]]));
  for (const name of files) hash.update(JSON.stringify(await fileIdentity(root, name, extraFiles.has(name), exclusions)));
  return sourceIdentitySchema.parse({ ...(revision ? { revision } : {}), digest: `sha256:${hash.digest("hex")}` });
}

export function excludeArchive(scope: SourceScope, archive: string): SourceScope {
  const root = resolve(scope.root);
  if (!isWithin(root, archive)) return scope;
  if (root === archive) throw new Error("The evidence archive must be separate from the source root.");
  return {
    ...scope,
    excludedPaths: [...scope.excludedPaths ?? [], portablePath(relative(root, archive))],
  };
}
