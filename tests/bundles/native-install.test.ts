import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const temporary: string[] = [];

function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "axiom-native-install-"));
  temporary.push(root);
  const repository = join(root, "checkout");
  mkdirSync(repository);
  for (const entry of ["core", "profiles", "skills", "LICENSE"]) {
    cpSync(join(checkout, entry), join(repository, entry), { recursive: true });
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "core.autocrlf=false", "add", ".");
  git("-c", "user.name=Axiom Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false",
    "commit", "-qm", "Reviewed fixture source");
  return { repository, root, revision: git("rev-parse", "HEAD") };
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("assembles all three versioned native distributions and a reproducible Hermes pin", async () => {
  const { runNativeBundle } = await import("../../packages/cli/src/native-install.js");
  const { repository, root, revision } = createWorkspace();
  const first = join(root, "first release");
  const second = join(root, "second release");
  const options = { repository, version: "0.2.5", profiles: ["angular-nx"] };
  const a = await runNativeBundle({ ...options, output: first });
  const b = await runNativeBundle({ ...options, output: second });
  expect(a.outcome).toEqual({ status: "passed" });
  expect(b.outcome).toEqual({ status: "passed" });
  const manifest = (directory: string) => JSON.parse(readFileSync(join(directory, "axiom-distribution.json"), "utf8"));
  expect(manifest(first)).toEqual(manifest(second));
  const { hosts, policy } = manifest(first);
  expect(manifest(first)).toMatchObject({ version: "0.2.5", sourceRevision: revision });
  expect(policy.profiles.map(({ id }: { id: string }) => id).sort()).toEqual(["angular-nx", "ui-atomic"]);
  expect(Object.keys(hosts)).toEqual(["claude", "codex", "hermes"]);
  expect(hosts.hermes.commit).toMatch(/^[a-f0-9]{40}$/);
  const list = execFileSync("git", ["ls-tree", "-r", "--name-only", hosts.hermes.commit], {
    cwd: join(first, "hermes"), encoding: "utf8",
  }).split(/\r?\n/);
  expect(list).toContain("plugin.yaml");
  expect(list).toContain("axiom-bundle.json");
  expect(list).toContain("LICENSE");
  expect(list).not.toEqual(expect.arrayContaining([expect.stringMatching(/(^|\/)evals\//)]));
  expect(JSON.parse(readFileSync(join(first, "claude/.claude-plugin/marketplace.json"), "utf8")))
    .toMatchObject({ name: "axiom-local", plugins: [{ name: "axiom", version: "0.2.5" }] });
  expect(JSON.parse(readFileSync(join(first, "codex/plugins/axiom/.codex-plugin/plugin.json"), "utf8")))
    .toMatchObject({ name: "axiom", version: "0.2.5" });
  expect(readFileSync(join(first, "codex/plugins/axiom/LICENSE"), "utf8"))
    .toBe(readFileSync(join(repository, "LICENSE"), "utf8").replace(/\r\n?/g, "\n"));
  expect(a.report?.hermesUrl).toContain("first%20release");
}, 30_000);

test("rejects unreviewed source changes and preserves a caller-owned destination", async () => {
  const { runNativeBundle } = await import("../../packages/cli/src/native-install.js");
  const { repository, root } = createWorkspace();
  const output = join(root, "existing");
  mkdirSync(output);
  writeFileSync(join(output, "keep.txt"), "preserve");
  expect((await runNativeBundle({ repository, output })).outcome).toMatchObject({ status: "blocked" });
  expect(readFileSync(join(output, "keep.txt"), "utf8")).toBe("preserve");
  writeFileSync(join(repository, "core/AXIOMS.md"), "Uncommitted policy edit.\n");
  expect((await runNativeBundle({ repository, output: join(root, "dirty") })).outcome)
    .toMatchObject({ status: "blocked", reason: expect.stringMatching(/uncommitted/) });
});
