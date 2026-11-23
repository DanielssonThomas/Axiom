import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { CommandInvocation } from "@axiom/evidence";
import type { CommandAuthority, CommandSource, DocumentCommand, VerificationKind } from "./model.js";

class ResolutionError extends Error {}

const packageManagers = ["npm", "pnpm", "yarn", "bun"];
const lockfiles = new Map([
  ["package-lock.json", "npm"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"],
]);

function repositoryPath(root: string, path: string): string {
  const offset = relative(root, path);
  if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`)) {
    throw new ResolutionError("The declared path is outside the repository.");
  }
  return offset.split(sep).join("/");
}

async function directory(root: string, name: string): Promise<string> {
  const path = await realpath(resolve(root, name)).catch(() => {
    throw new ResolutionError("The declared working directory is unavailable.");
  });
  repositoryPath(root, path);
  if (!(await stat(path)).isDirectory()) throw new ResolutionError("The declared working directory is not a directory.");
  return path;
}

async function authority(root: string, path: string, heading?: string): Promise<{ source: CommandAuthority; contents: string }> {
  try {
    const requested = resolve(root, path);
    const relativePath = repositoryPath(root, requested);
    const location = await realpath(requested);
    repositoryPath(root, location);
    if (!(await stat(location)).isFile()) throw new ResolutionError(`The authoritative path ${path} must be a regular file.`);
    const bytes = await readFile(location);
    return {
      source: { path: relativePath, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, ...(heading === undefined ? {} : { heading }) },
      contents: bytes.toString("utf8"),
    };
  } catch (error) {
    if (error instanceof ResolutionError) throw error;
    throw new ResolutionError(`Could not read authoritative file ${path}.`);
  }
}

function commandLines(contents: string, requestedHeading: string): string[] {
  let fence: { mark: string; shell: boolean } | undefined;
  let depth: number | undefined;
  let matches = 0;
  const commands: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})\s*([^\s]*)\s*$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.mark[0] && marker[1]!.length >= fence.mark.length && marker[2] === "") {
        fence = undefined;
      } else if (depth !== undefined && fence.shell && line.trim() && !line.trimStart().startsWith("#")) {
        commands.push(line.trim());
      }
      continue;
    }
    if (marker) {
      fence = { mark: marker[1]!, shell: /^(?:sh|bash|shell)$/.test(marker[2]!) };
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (depth !== undefined && level <= depth) depth = undefined;
      if (heading[2] === requestedHeading) {
        depth = level;
        matches += 1;
      }
    }
  }
  if (matches !== 1) throw new ResolutionError("The documented command heading is missing or ambiguous.");
  return commands;
}

/** Parse standalone executable and argument literals. Shell syntax requires its own existing repository script. */
function argv(line: string): string[] {
  const fragments = line.match(/[^\s'"$`\\;&|<>*?()[\]{}~]+|'[^']*'|"[^"$`\\]*"|\s+|./g) ?? [];
  const args: string[] = [];
  let word: string | undefined;
  for (const fragment of fragments) {
    if (/^\s+$/.test(fragment)) {
      if (word !== undefined) args.push(word);
      word = undefined;
    } else if (/^'[^']*'$|^"[^"$`\\]*"$/.test(fragment)) {
      word = (word ?? "") + fragment.slice(1, -1);
    } else if (/^[^\s'"$`\\;&|<>*?()[\]{}~]+$/.test(fragment)) {
      word = (word ?? "") + fragment;
    } else {
      throw new ResolutionError("The documented command contains unsupported shell syntax or quoting.");
    }
  }
  if (word !== undefined) args.push(word);
  if (!args[0] || /^[\w-]+=/.test(args[0])) {
    throw new ResolutionError("The documented command requires a literal executable without shell assignments.");
  }
  return args;
}

async function fromDocumentation(root: string, docs: DocumentCommand, sources: CommandAuthority[]): Promise<string[]> {
  const { source, contents } = await authority(root, docs.path, docs.heading);
  sources.push(source);
  const commands = commandLines(contents, docs.heading);
  const command = docs.commandIndex === undefined
    ? commands.length === 1 ? commands[0] : undefined
    : commands[docs.commandIndex];
  if (!command) throw new ResolutionError("Select one documented shell command by heading and, if needed, command index.");
  return argv(command);
}

function canonicalArgv(args: string[], script: string | undefined): string[] {
  if (!packageManagers.includes(args[0]!)) return args;
  if (args[1] === "run") return args;
  if (args[1] === script || args[1] === "test") return [args[0]!, "run", ...args.slice(1)];
  return args;
}

function configuration(contents: string): { scripts?: Record<string, unknown>; packageManager?: string } {
  try {
    const parsed = JSON.parse(contents) as { scripts?: unknown; packageManager?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const { scripts, packageManager } = parsed;
    if (packageManager !== undefined && typeof packageManager !== "string") throw new Error();
    if (scripts !== undefined && (!scripts || typeof scripts !== "object" || Array.isArray(scripts))) throw new Error();
    return {
      ...(packageManager === undefined ? {} : { packageManager }),
      ...(scripts === undefined ? {} : { scripts: scripts as Record<string, unknown> }),
    };
  } catch {
    throw new ResolutionError("package.json does not contain valid repository command configuration.");
  }
}

async function fromScript(root: string, cwd: string, script: NonNullable<CommandSource["script"]>, sources: CommandAuthority[]) {
  const path = repositoryPath(root, resolve(cwd, "package.json"));
  const local = await authority(root, path);
  sources.push(local.source);
  const config = configuration(local.contents);
  const scriptBody = config.scripts?.[script.name];
  if (script.name.startsWith("-") || !config.scripts || !Object.hasOwn(config.scripts, script.name) ||
      typeof scriptBody !== "string" || !scriptBody.trim()) {
    throw new ResolutionError(`The package script ${script.name} is unavailable.`);
  }

  const managers = new Set<string>();
  if (config.packageManager) managers.add(config.packageManager.split("@")[0]!);
  if (cwd !== root) {
    const rootManifestExists = await stat(resolve(root, "package.json")).then((info) => info.isFile(), () => false);
    if (rootManifestExists) {
      const manifest = await authority(root, "package.json");
      sources.push(manifest.source);
      const rootManager = configuration(manifest.contents).packageManager;
      if (rootManager) managers.add(rootManager.split("@")[0]!);
    }
  }
  for (const [filename, manager] of lockfiles) {
    if (await stat(resolve(root, filename)).then((info) => info.isFile(), () => false)) {
      const lock = await authority(root, filename);
      sources.push(lock.source);
      managers.add(manager);
    }
  }
  if (managers.size > 1) throw new ResolutionError("Repository configuration declares conflicting package managers.");
  const [manager] = managers;
  if (!manager || !packageManagers.includes(manager)) throw new ResolutionError("The repository package manager could not be resolved.");
  return { args: [manager, "run", script.name, ...script.args ?? []], scripts: config.scripts };
}

function commandName(executable: string): string {
  return basename(executable).replace(/\.(?:exe|cmd)$/i, "").toLowerCase();
}

function wrappedCommand(args: string[]): string[] | undefined {
  const subcommand = args[1];
  if (packageManagers.includes(commandName(args[0]!)) && subcommand && ["exec", "dlx", "x"].includes(subcommand)) {
    return args.slice(args[2] === "--" ? 3 : 2);
  }
}

function validateInvocation(kind: VerificationKind, args: string[]): void {
  const executable = commandName(args[0]!);
  const subcommand = args[1];
  const wrapped = wrappedCommand(args);
  if (wrapped?.length) validateInvocation(kind, wrapped);
  if (/^(?:sh|bash|zsh|dash|ksh|fish|cmd|powershell|pwsh)$/.test(executable) &&
      args.slice(1).some((arg) => /^-[a-z]*c[a-z]*$|^-(?:command|encodedcommand)$|^\/[ck]$/i.test(arg))) {
    throw new ResolutionError("Repository command strings passed to a shell are unsupported.");
  }
  if (kind === "automated") return;
  const operation = packageManagers.includes(executable) && subcommand === "run" ? args[2] : subcommand;
  const structural = /^(?:build|lint|typecheck|format)(?:[:._-]|$)/i;
  if (/^(?:tsc|eslint|prettier|stylelint)$/.test(executable) || (operation && structural.test(operation))) {
    throw new ResolutionError("An automated build, lint, or type check cannot verify live application behavior.");
  }
}

function invokedScript(args: string[]): string | undefined {
  if (!args[0] || !packageManagers.includes(commandName(args[0]))) return;
  const wrapped = wrappedCommand(args);
  if (wrapped) return invokedScript(wrapped);
  const subcommand = args[1];
  if (subcommand === "run" || subcommand === "run-script") {
    if (!args[2]) throw new ResolutionError("A live package command requires a named script.");
    return args[2];
  }
  return subcommand;
}

function validateLiveScript(
  kind: VerificationKind, script: string, scripts: Record<string, unknown>, seen = new Set<string>(),
): void {
  if (seen.has(script)) throw new ResolutionError("The live package script has a cyclic alias.");
  seen.add(script);
  const body = scripts[script];
  if (!Object.hasOwn(scripts, script) || typeof body !== "string" || !body.trim()) {
    throw new ResolutionError(`The package script ${script} is unavailable.`);
  }
  let command: string[];
  try {
    command = argv(body);
  } catch (error) {
    if (!(error instanceof ResolutionError)) throw error;
    // A native script can compose a launch and a probe. Inspect single commands
    // and alias chains without reimplementing the package manager's shell.
    return;
  }
  validateInvocation(kind, command);
  const alias = invokedScript(command);
  if (alias !== undefined) validateLiveScript(kind, alias, scripts, seen);
}

export async function resolveInvocation(
  root: string, kind: VerificationKind, command: CommandSource, sources: CommandAuthority[],
): Promise<CommandInvocation> {
  const cwd = await directory(root, command.cwd ?? ".");
  const candidates: string[][] = [];
  const configured = command.script ? await fromScript(root, cwd, command.script, sources) : undefined;
  if (configured) candidates.push(configured.args);
  for (const docs of command.docs ?? []) {
    candidates.push(canonicalArgv(await fromDocumentation(root, docs, sources), command.script?.name));
  }
  const [candidate, ...others] = candidates;
  if (!candidate) throw new ResolutionError("No repository command source was specified.");
  if (others.some((args) => JSON.stringify(args) !== JSON.stringify(candidate))) {
    throw new ResolutionError("Repository configuration and documentation specify conflicting commands.");
  }
  validateInvocation(kind, candidate);
  if (kind !== "automated") {
    const script = invokedScript(candidate);
    if (script !== undefined) {
      let scripts = configured?.scripts;
      if (!scripts) {
        const manifest = await authority(root, repositoryPath(root, resolve(cwd, "package.json")));
        sources.push(manifest.source);
        scripts = configuration(manifest.contents).scripts ?? {};
      }
      validateLiveScript(kind, script, scripts);
    }
  }
  const [executable, ...args] = candidate;
  if (!executable || executable.includes("\0") || args.some((argument) => argument.includes("\0"))) {
    throw new ResolutionError("The command must have a literal executable and valid argv.");
  }
  return { executable, args, cwd };
}

export function resolutionReason(error: unknown): string {
  return error instanceof ResolutionError ? error.message : "The repository command could not be resolved.";
}
