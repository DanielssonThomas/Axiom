import { expect, test } from "vitest";
import { assessInstalledHost, behaviorRequirements, transportRequirements } from "./qualification.js";

const passed = { status: "passed" } as const;

test("native loopback success leaves independently evaluated model behavior unqualified", () => {
  const transport = Object.fromEntries(transportRequirements.map((requirement) => [requirement, passed]));
  const report = assessInstalledHost(transport);
  expect(report.transport).toEqual(passed);
  expect(report.outcome.status).toBe("blocked");
  for (const requirement of behaviorRequirements) expect(report.checks[requirement].status).toBe("not_run");
});

test("retains failures and refuses unsupported, stale, or missing required observations", () => {
  const transport = Object.fromEntries(transportRequirements.map((requirement) => [requirement, passed]));
  for (const incomplete of [
    { status: "blocked", reason: "The recorded revision is stale." },
    { status: "not_run", reason: "A provider was unavailable." },
    { status: "not_applicable", reason: "The current host cannot provide this evidence." },
    undefined,
  ]) {
    expect(assessInstalledHost({ ...transport, ordinarySession: incomplete }).transport.status)
      .toBe("blocked");
  }
  expect(assessInstalledHost({
    ...transport, disabledControl: { status: "failed", reason: "Disabled policy reached the model." },
  }).outcome.status).toBe("failed");
});
