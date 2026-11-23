import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { digestSchema } from "@axiom/contracts";
import type { BundleFile } from "./model.js";

const excluded = new Set([
  ".axiom", ".envrc", ".git", ".git-credentials", ".netrc", ".npmrc", ".pypirc",
  "auth.json", "cache", "coverage", "credentials", "evals",
  "fixtures", "graders", "held-out", "held_out", "node_modules", "playwright-report",
  "private", "runs", "secrets", "test-results", "tests",
]);

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function runtimePath(path: string): string {
  for (const part of path.split("/")) {
    const name = part.toLowerCase();
    if (!/^[a-z0-9_.+-]+$/i.test(part) || part === "." || part.endsWith(".")
      || /^(?:con|nul|prn|aux|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      || excluded.has(name) || /^\.env(?:\.|$)|^(?:credentials|secrets|held[-_]out)\.|\.(?:log|pem|key|p12)$/i.test(part)) {
      throw new Error(`Invalid runtime path: ${path}.`);
    }
  }
  return path;
}

export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function readRuntimeFile(root: string, path: string): BundleFile {
  runtimePath(path);
  const filename = resolve(root, path);
  let actual: string;
  try {
    actual = realpathSync(filename);
    if (!statSync(actual).isFile()) throw new Error("Not a file");
  } catch {
    throw new Error(`Missing runtime file or reference: ${path}.`);
  }
  if (filename !== actual) throw new Error(`Runtime references must not follow a symlink: ${path}.`);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(actual));
  return { path, text: normalizeText(text) };
}

export function sha256(text: string): string {
  return digestSchema.parse("sha256:" + createHash("sha256").update(text).digest("hex"));
}

export function orderedFiles(files: readonly BundleFile[]): BundleFile[] {
  const seen = new Set<string>();
  const ordered = files.map(({ path, text }) => ({ path: runtimePath(path), text: normalizeText(text) }))
    .sort((a, b) => compare(a.path, b.path));
  for (const { path } of ordered) {
    const portable = path.toLowerCase();
    if (seen.has(portable)) throw new Error(`Duplicate runtime path: ${path}.`);
    seen.add(portable);
  }
  return ordered;
}

export function fileHashes(files: readonly BundleFile[]) {
  return files.map(({ path, text }) => ({ path, digest: sha256(text) }));
}
