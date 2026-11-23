import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

export async function nativeProgram(agent: string, explicit?: string) {
  if (explicit !== undefined && !isAbsolute(explicit)) throw new Error("Supply an absolute native CLI executable path.");
  const candidates = explicit ? [explicit] : (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).flatMap((directory) =>
    (process.platform === "win32" ? [agent + ".exe", agent] : [agent]).map((name) => join(directory, name)));
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return realpath(candidate);
  }
  throw new Error(`The pinned ${agent} executable is unavailable. Use --program to select it.`);
}
