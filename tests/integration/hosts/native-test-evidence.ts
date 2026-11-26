type ObservedTest = { id: string; status: "passed" | "failed" };

/** Admit only complete, non-skipped Node TAP results from a completed native test command. */
export function observedNodeTests(output: string, exitCode: number): ObservedTest[] | undefined {
  const lines = output.split(/\r?\n/);
  const header = lines.indexOf("TAP version 13");
  if (header < 0 || header !== lines.lastIndexOf("TAP version 13")) return;

  const tests: ObservedTest[] = [];
  const names = new Set<string>();
  for (const line of lines.slice(header + 1)) {
    const match = /^(ok|not ok) (\d+) - (.+)$/.exec(line);
    if (!match) continue;
    const id = match[3]!;
    if (Number(match[2]) !== tests.length + 1 || names.has(id) || /\s+# (?:skip|todo)\b/i.test(id)) return;
    names.add(id);
    tests.push({ id, status: match[1] === "ok" ? "passed" : "failed" });
  }
  if (!tests.length) return;
  const failed = tests.filter(({ status }) => status === "failed").length;
  if (exitCode !== (failed ? 1 : 0)) return;
  const footer = lines.filter((line) => /^(?:1\.\.|# (?:tests|pass|fail|cancelled|skipped|todo) )/.test(line));
  if (footer.join("\n") !== [
    "1.." + tests.length,
    "# tests " + tests.length,
    "# pass " + (tests.length - failed),
    "# fail " + failed,
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
  ].join("\n")) return;
  return tests;
}
