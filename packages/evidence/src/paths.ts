import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

export function portablePath(path: string): string {
  return path.split(sep).join("/");
}

export function isWithin(directory: string, target: string): boolean {
  const offset = relative(directory, target);
  return !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
}

export function relativePath(path: string): string {
  const portable = portablePath(path);
  if (!portable || portable.startsWith("/") || /^[A-Za-z]:/.test(portable) ||
      portable.includes("\\") || portable.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Expected a relative path without traversal.");
  }
  return portable;
}

export function isMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code } = error as NodeJS.ErrnoException;
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}
