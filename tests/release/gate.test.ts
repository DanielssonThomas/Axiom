import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { verifyQualification, verifyRollback } from "./gate.ts";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./evidence/${name}.json`, import.meta.url), "utf8"));
const source = "ef35e6f5fb881db878a9547f124f8c28a08b414e";
const previousSource = "96014e73ca14111be83c448898e41559f0f87f88";
const previousDigest = `sha256:${"a".repeat(64)}`;
const settingsDigest = `sha256:${"b".repeat(64)}`;

test("admits the complete release with both scoped installed hosts", () => {
  expect(() => verifyQualification(load("v1-hosts"), load("v1-distribution"), source)).not.toThrow();
});

test.each([
  ["missing host", (row) => row.hosts.pop(), /required host hermes/i],
  ["stale source", (row) => row.hosts[1].cases[0].sourceRevision = previousSource, /stale/i],
  ["stale policy", (row) => row.hosts[0].policy.digest = previousDigest, /policy/i],
  ["wrong bundle", (row) => row.hosts[1].bundleDigest = previousDigest, /bundle/i],
  ["missing native lifecycle", (row) => delete row.hosts[0].nativeLifecycle, /native lifecycle/i],
  ["missing installed context", (row) => delete row.hosts[0].cases[0].installedContext, /installed context/i],
  ["a required not_applicable result", (row) => {
    row.hosts[0].cases[1].assertions[4].outcome = { status: "not_applicable", reason: "Unavailable" };
  }, /preserve-acceptance/i],
  ["a failure hidden by an aggregate", (row) => {
    row.score = 1;
    row.hosts[0].cases[1].assertions[4].outcome = { status: "failed", reason: "Missing protected check" };
  }, /preserve-acceptance/i],
  ["missing required assertion", (row) => row.hosts[0].cases[1].assertions.pop(), /demonstrate-prevention/i],
  ["partial native RED suite", (row) => {
    row.hosts[1].cases[1].nativeCheckReceipts[0].tests =
      row.hosts[1].cases[1].nativeCheckReceipts[0].tests.filter(({ id }: { id: string }) => id !== "formats a single catalog word");
  }, /complete declared suite/i],
  ["unproved byte equivalence", (row) => delete row.codexEquivalence, /equivalence/i],
] satisfies [string, (row: ReturnType<typeof load>) => void, RegExp][])("rejects %s", (_description, change, message) => {
  const record = load("v1-hosts");
  change(record);
  expect(() => verifyQualification(record, load("v1-distribution"), source)).toThrow(message);
});

function rollbackFixture() {
  const distribution = load("v1-distribution");
  const observations = (digest: string, sourceRevision: string, version: string, policy: unknown, commit?: string) =>
    ({ digest, sourceRevision, version, policy, commit, settingsDigest, outcome: { status: "passed" } });
  const rollback = {
    schemaVersion: 1, sourceRevision: source, os: "linux", architecture: "x86_64",
    previousSourceRevision: previousSource, previousVersion: "0.0.9",
    hosts: (["codex", "hermes"] as const).map((agent) => ({
      agent, version: distribution.hosts[agent].hostVersion,
      before: observations(previousDigest, previousSource, "0.0.9", distribution.policy,
        agent === "hermes" ? "c".repeat(40) : undefined),
      updated: observations(distribution.hosts[agent].digest, source, distribution.version, distribution.policy,
        distribution.hosts[agent].commit),
      restored: observations(previousDigest, previousSource, "0.0.9", distribution.policy,
        agent === "hermes" ? "c".repeat(40) : undefined),
    })),
  };
  return { distribution, rollback };
}

test("admits native update and rollback preserving exact user configuration", () => {
  const { distribution, rollback } = rollbackFixture();
  expect(() => verifyRollback(rollback, distribution)).not.toThrow();
});

test("rejects rollback to different bytes or changed settings", () => {
  const { distribution, rollback } = rollbackFixture();
  const host = rollback.hosts[1]!;
  host.restored.digest = settingsDigest;
  expect(() => verifyRollback(rollback, distribution)).toThrow(/restored.*bundle/i);
  host.restored.digest = host.before.digest;
  host.updated.settingsDigest = previousDigest;
  expect(() => verifyRollback(rollback, distribution)).toThrow(/settings/i);
});