import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { digestSchema } from "@axiom/contracts";
import { fileHashes, orderedFiles, runtimePath, sha256 } from "./content.js";
import type { BundleArtifact, BundleFile, WrittenBundle } from "./model.js";

function verifyExisting(directory: string, expected: readonly BundleFile[]) {
  if (lstatSync(directory).isSymbolicLink()) throw new Error("An artifact directory cannot be a symlink.");
  const files = new Map(expected.map(({ path, text }) => [path, text]));
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const item = join(entry.parentPath, entry.name);
    const path = relative(directory, item).split(sep).join("/");
    const text = files.get(path);
    if (!entry.isFile() || text === undefined || !readFileSync(item).equals(Buffer.from(text, "utf8"))) {
      throw new Error(`Existing artifact differs at ${path}.`);
    }
    files.delete(path);
  }
  if (files.size > 0) throw new Error(`Existing artifact is missing ${[...files.keys()].join(", ")}.`);
}

export function writeBundles(outputDirectory: string, artifacts: readonly BundleArtifact[]): WrittenBundle[] {
  return artifacts.map(({ manifest, files }) => {
    const { digest, ...inventory } = manifest;
    const payload = orderedFiles(files);
    const hashes = fileHashes(payload);
    if (sha256(JSON.stringify(inventory)) !== digest || JSON.stringify(hashes) !== JSON.stringify(manifest.files)) {
      throw new Error("Bundle contents do not match their manifest.");
    }
    const entries = orderedFiles([...payload, { path: "axiom-bundle.json", text: JSON.stringify(manifest, null, 2) + "\n" }]);
    const parent = resolve(outputDirectory, runtimePath(manifest.version), runtimePath(manifest.host));
    const directory = join(parent, digestSchema.parse(digest).slice("sha256:".length));
    mkdirSync(parent, { recursive: true });
    if (existsSync(directory)) {
      verifyExisting(directory, entries);
      return { manifest, directory };
    }
    const stage = mkdtempSync(join(parent, ".axiom-stage-"));
    try {
      for (const entry of entries) {
        const file = join(stage, entry.path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, entry.text, { flag: "wx" });
      }
      try {
        renameSync(stage, directory);
      } catch (error) {
        if (!existsSync(directory)) throw error;
        verifyExisting(directory, entries);
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    return { manifest, directory };
  });
}
