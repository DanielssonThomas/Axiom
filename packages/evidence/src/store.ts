import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { artifactReferenceSchema, evidenceSchema, type ArtifactReference, type Evidence } from "@axiom/contracts";
import { digestFile, isMissing, isWithin, relativePath } from "./paths.js";

export type EvidencePhase = "red" | "acceptance";

export interface SelectedArtifact {
  kind: string;
  /** Explicitly curated, archive-relative file. Raw process streams belong to the executor. */
  path: string;
}

export class EvidenceStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async record(phase: EvidencePhase, evidence: Evidence): Promise<void> {
    const record = evidenceSchema.parse(evidence);
    if (phase === "red" && (record.outcome.status !== "failed" || record.provenance !== "observed")) {
      throw new Error("RED history requires an observed failure.");
    }
    const path = this.recordPath(phase, record.id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const staging = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await writeFile(staging, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await link(staging, path);
    } finally {
      await rm(staging, { force: true });
    }
  }

  async read(phase: EvidencePhase, id: string): Promise<Evidence | undefined> {
    try {
      const record = evidenceSchema.parse(JSON.parse(await readFile(this.recordPath(phase, id), "utf8")));
      if (record.id !== id) throw new Error("Record identity does not match the archive path.");
      return record;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async artifact({ kind, path }: SelectedArtifact): Promise<ArtifactReference | undefined> {
    const location = relativePath(path);
    try {
      const archive = await realpath(this.directory);
      const file = await realpath(join(archive, location));
      if (!isWithin(archive, file) || !(await stat(file)).isFile()) return undefined;
      return artifactReferenceSchema.parse({ kind, location, digest: await digestFile(file) });
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private recordPath(phase: EvidencePhase, id: string): string {
    if (phase !== "red" && phase !== "acceptance") throw new Error("Unknown evidence phase.");
    return join(this.directory, phase, `${evidenceSchema.shape.id.parse(id)}.json`);
  }
}
