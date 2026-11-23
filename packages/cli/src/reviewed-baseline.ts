import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const sha256 = (bytes: string | Buffer) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
export const isCommit = (value: string | undefined): value is string => Boolean(value && /^[a-f0-9]{40}$/.test(value));

export interface ReviewedBaseline {
  directory: string;
  digest: string;
}

/** Only Git archive bytes at a pinned ancestor enter the verifier baseline. */
export async function prepareReviewedBaseline(
  checkout: string, temporary: string, revision: string, input: { baselineRef: string; baselineDigest?: string },
): Promise<ReviewedBaseline> {
  if (!isCommit(revision) || !isCommit(input.baselineRef)) throw new Error("A reviewed revision is required.");
  await exec("git", ["merge-base", "--is-ancestor", input.baselineRef, revision], { cwd: checkout, timeout: 10_000 }).catch(() => {
    throw new Error("The baseline is outside the reviewed revision's history.");
  });
  const { stdout } = await exec("git", ["archive", "--format=tar", input.baselineRef, "--", "core", "evals", "profiles", "skills"], {
    cwd: checkout, encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 10_000,
  });
  const digest = sha256(stdout);
  if (input.baselineDigest !== undefined && digest !== input.baselineDigest) throw new Error("The reviewed baseline digest does not match.");
  const directory = await mkdtemp(join(temporary, "axiom-reviewed-"));
  const archive = join(directory, "baseline.tar");
  try {
    await writeFile(archive, stdout, { flag: "wx", mode: 0o600 });
    await exec("tar", ["-xf", archive, "-C", directory], { timeout: 10_000 });
    await rm(archive);
    return { directory, digest };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function benchmarkRevision(checkout: string) {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8", timeout: 5_000 });
  const revision = stdout.trim();
  if (!isCommit(revision)) throw new Error("The checkout has no committed source revision.");
  return revision;
}

export async function requireCleanBenchmarkRevision(checkout: string) {
  const revision = await benchmarkRevision(checkout);
  const { stdout } = await exec("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: checkout, encoding: "utf8", timeout: 5_000,
  });
  if (stdout || revision !== await benchmarkRevision(checkout)) throw new Error("The trusted checkout changed or contains uncommitted files.");
  return revision;
}

export async function writeReviewedLicense(checkout: string, baseline: ReviewedBaseline, revision: string) {
  if (!isCommit(revision)) throw new Error("A reviewed revision is required.");
  const { stdout } = await exec("git", ["show", `${revision}:LICENSE`], { cwd: checkout, encoding: "buffer", timeout: 5_000 });
  await writeFile(join(baseline.directory, "LICENSE"), stdout, { mode: 0o600 });
}
