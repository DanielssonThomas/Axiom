import { expect, test } from "vitest";
import { observedNodeTests } from "./native-test-evidence.js";

function report(prefix = "not ok", failures = 1) {
  return [
    "Wall time: 0.12 seconds",
    "Output:",
    "TAP version 13",
    "ok 1 - catalog command acceptance",
    prefix + " 2 - formats multiword catalog keys",
    "1..2",
    "# tests 2",
    "# suites 0",
    "# pass " + (2 - failures),
    "# fail " + failures,
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 12.33",
  ].join("\n");
}

test("reads named tests from complete RED and GREEN output with the native exit status", () => {
  expect(observedNodeTests(report(), 1)).toEqual([
    { id: "catalog command acceptance", status: "passed" },
    { id: "formats multiword catalog keys", status: "failed" },
  ]);
  expect(observedNodeTests(report("ok", 0), 0)?.map(({ status }) => status)).toEqual(["passed", "passed"]);
});

test("rejects incomplete, contradictory and ambiguous native test results", () => {
  const red = report();
  for (const [output, exit] of [
    [red, 0],
    [red, 137],
    [red.split("\n").slice(0, 7).join("\n"), 1],
    [red.replace("# fail 1", "# fail 0"), 1],
    [red.replace("ok 2 -", "ok 1 -"), 1],
    [red.replace("formats multiword catalog keys", "catalog command acceptance"), 1],
    [red.replace("# skipped 0", "# skipped 1"), 1],
    [red + "\n" + red, 1],
  ] as const) expect(observedNodeTests(output, exit)).toBeUndefined();
});
