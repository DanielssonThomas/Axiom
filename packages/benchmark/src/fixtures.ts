import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { EvaluationCase } from "@axiom/contracts";
import type { SourceScope } from "@axiom/evidence";

interface FixtureFile {
  readonly bytes: Buffer;
  readonly mode: number;
}

type FixtureFiles = ReadonlyMap<string, FixtureFile>;

const fixtureShapeReasons = {
  root: "The delivered fixture root must be an ordinary directory.",
  git: "The delivered fixture contains Git metadata.",
  path: "The delivered fixture contains a nonportable path.",
  link: "The delivered fixture contains a symbolic link or multiply linked file.",
  entry: "The delivered fixture contains an unsupported filesystem entry.",
};

class FixtureShapeError extends Error {
  constructor(kind: keyof typeof fixtureShapeReasons) {
    super(fixtureShapeReasons[kind]);
  }
}

/** Retain only fixed diagnostics from delivered-fixture capture. */
export function fixtureCaptureReason(error: unknown): string {
  if (error instanceof FixtureShapeError) return error.message;
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return "The delivered fixture was missing or changed during capture.";
  if (code === "EACCES" || code === "EPERM") return "Access to the delivered fixture was denied during capture.";
  return "The delivered fixture could not be captured for independent grading.";
}

function pathParts(path: string): string[] {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[:\\\0]/.test(part))) {
    throw new FixtureShapeError("path");
  }
  return parts;
}

export async function readFixture(root: string): Promise<FixtureFiles> {
  if (!(await lstat(root)).isDirectory()) throw new FixtureShapeError("root");
  const files = new Map<string, FixtureFile>();
  async function readDirectory(directory: string, parent = ""): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      if (name === ".git") throw new FixtureShapeError("git");
      const relative = parent + name;
      pathParts(relative);
      const source = join(directory, name);
      const info = await lstat(source);
      if (info.isDirectory()) {
        await readDirectory(source, `${relative}/`);
      } else if (info.isFile() && info.nlink === 1) {
        files.set(relative, { bytes: await readFile(source), mode: 0o600 | (info.mode & 0o100) });
      } else if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) {
        throw new FixtureShapeError("link");
      } else throw new FixtureShapeError("entry");
    }
  }
  await readDirectory(root);
  return files;
}

export async function loadFixture(repository: string, evaluation: EvaluationCase): Promise<FixtureFiles> {
  const root = await realpath(repository);
  const fixture = evaluation.fixture;
  const prefixes = evaluation.skill
    ? [`skills/${evaluation.skill.id}/evals/fixtures/`]
    : ["evals/cases/fixtures/", ...evaluation.profiles.map(({ id }) => `profiles/${id}/evals/fixtures/`)];
  if (!prefixes.some((prefix) => fixture.startsWith(prefix))) throw new Error("The fixture is outside approved case fixture paths.");
  const path = join(root, ...pathParts(fixture));
  if (await realpath(path) !== path) throw new Error("The fixture path traverses a symbolic link.");
  return readFixture(path);
}

export async function stageFixture(directory: string, files: FixtureFiles): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, file] of files) {
    const destination = join(directory, ...pathParts(name));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.bytes, { flag: "wx", mode: file.mode });
  }
}

const exec = promisify(execFile);

/** Construct a checkout that only the verifier sees, for the shared evidence source resolver. */
export async function evidenceSource(root: string, files: FixtureFiles): Promise<SourceScope> {
  await stageFixture(root, files);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "" };
  await exec("git", ["init", "--quiet", "--template=", root], { cwd: root, env });
  return { root, extraFiles: [...files.keys()] };
}

export function fixtureText(files: FixtureFiles): ReadonlyMap<string, string> {
  return new Map([...files].map(([path, file]) => [path, file.bytes.toString("utf8")]));
}
