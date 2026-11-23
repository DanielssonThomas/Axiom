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

function pathParts(path: string): string[] {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[:\\\0]/.test(part))) {
    throw new Error("Fixture paths must use repository-relative segments.");
  }
  return parts;
}

export async function readFixture(root: string): Promise<FixtureFiles> {
  if (!(await lstat(root)).isDirectory()) throw new Error("The fixture root must be a regular directory.");
  const files = new Map<string, FixtureFile>();
  async function readDirectory(directory: string, parent = ""): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      if (name === ".git") throw new Error("Fixture files cannot carry Git metadata.");
      const relative = parent + name;
      pathParts(relative);
      const source = join(directory, name);
      const info = await lstat(source);
      if (info.isDirectory()) {
        await readDirectory(source, `${relative}/`);
      } else if (info.isFile() && info.nlink === 1) {
        files.set(relative, { bytes: await readFile(source), mode: 0o600 | (info.mode & 0o100) });
      } else {
        throw new Error("Fixture entries must be ordinary files and directories.");
      }
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
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  await exec("git", ["init", "--quiet", "--template=", root], { cwd: root, env });
  return { root, extraFiles: [...files.keys()] };
}

export function fixtureText(files: FixtureFiles): ReadonlyMap<string, string> {
  return new Map([...files].map(([path, file]) => [path, file.bytes.toString("utf8")]));
}
