import { isDeepStrictEqual } from "node:util";
import { digestSchema, evidenceOutcomeSchema, policyIdentitySchema } from "@axiom/contracts";
import { transportRequirements } from "../integration/hosts/qualification.ts";

const hosts = { codex: "exec", hermes: "named-profile-cli" } as const;
const behavior = {
  clarification: {
    codex: ["resolve-format-decision", "clarify-material-format"],
    hermes: ["clarify-material-decision", "clarify-before-edit"],
  },
  settled: ["settled-catalog-repair", "inspect-and-proceed", "use-owned-formatter", "reference-canonical-model",
    "keep-small-owned-change", "preserve-acceptance", "demonstrate-prevention"],
  reuse: ["reuse-summary-formatter", "reuse-formatter", "keep-command-cohesive"],
  preview: ["report-unavailable-preview", "report-preview-gap"],
  delegation: ["preserve-delegated-requirements", "verify-delegated-result"],
} as const;
const revision = /^[a-f0-9]{40}$/;

type RecordFields = Record<string, unknown>;

function requireCheck(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function object(value: unknown, label: string): RecordFields {
  requireCheck(value !== null && typeof value === "object" && !Array.isArray(value), `Missing or invalid ${label}.`);
  return value as RecordFields;
}

function uniqueRows(value: unknown, key: string, label: string) {
  requireCheck(Array.isArray(value), `Missing ${label}.`);
  const rows = new Map<string, RecordFields>();
  for (const entry of value) {
    const row = object(entry, label);
    const id = row[key];
    requireCheck(typeof id === "string" && id.length > 0 && !rows.has(id), `Invalid or duplicate ${label} identity.`);
    rows.set(id, row);
  }
  return rows;
}

function passed(value: unknown): boolean {
  const outcome = evidenceOutcomeSchema.safeParse(value);
  return outcome.success && outcome.data.status === "passed";
}

function samePolicy(value: unknown, expected: unknown, label: string) {
  const policy = policyIdentitySchema.safeParse(value);
  requireCheck(policy.success && isDeepStrictEqual(policy.data, expected), `${label} policy identity differs.`);
}

function checkReceipts(row: RecordFields, kind: string) {
  if (kind !== "settled" && kind !== "delegation") return;
  const receipts = row.nativeCheckReceipts;
  requireCheck(Array.isArray(receipts) && receipts.length === (kind === "settled" ? 2 : 1),
    `Required ${kind} native test receipts are absent.`);
  const checks = receipts.map((receipt) => {
    const result = object(receipt, "native test receipt");
    requireCheck(digestSchema.safeParse(result.source).success && digestSchema.safeParse(result.report).success,
      "A native test receipt lacks a source or report digest.");
    return { exit: result.exitCode, source: result.source, tests: uniqueRows(result.tests, "id", "native test results") };
  });
  if (kind === "delegation") {
    requireCheck(checks[0]!.exit === 0 && checks[0]!.tests.get("subscription displays the confirmed label")?.status === "passed" &&
      typeof row.workerDurationMs === "number" && Number.isSafeInteger(row.workerDurationMs) &&
      row.workerDurationMs > 0 && row.workerDurationMs <= 30_000, "The worker or parent acceptance test did not pass within scope.");
    return;
  }
  const [red, green] = checks as [typeof checks[number], typeof checks[number]];
  const protectedTest = "catalog command acceptance";
  const regression = "formats multiword catalog keys";
  const expectedTests = [protectedTest, "formats a single catalog word", regression];
  requireCheck([red, green].every(({ tests }) => tests.size === expectedTests.length &&
    expectedTests.every((id) => tests.has(id))), "Both receipts must contain the complete declared suite.");
  requireCheck(red.exit === 1 && green.exit === 0 && red.source !== green.source,
    "Settled-work RED and GREEN require different independently observed source states.");
  requireCheck(red.tests.get(protectedTest)?.status === "passed" && green.tests.get(protectedTest)?.status === "passed",
    "Protected acceptance must pass in RED and GREEN.");
  requireCheck(red.tests.get(regression)?.status === "failed" && green.tests.get(regression)?.status === "passed" &&
    [...red.tests].every(([id, test]) => id === regression || test.status === "passed") &&
    [...green.tests.values()].every((test) => test.status === "passed"), "The new regression must be the only RED failure.");
}

/** Admit the reviewed evidence for the v1 native default configurations. */
export function verifyQualification(input: unknown, staged: unknown, sourceRevision: string): void {
  const record = object(input, "release record");
  const distribution = object(staged, "native distribution");
  requireCheck(record.schemaVersion === 1 && distribution.schemaVersion === 1 &&
    revision.test(sourceRevision) && record.sourceRevision === sourceRevision &&
    distribution.sourceRevision === sourceRevision && record.bundleVersion === distribution.version &&
    typeof distribution.version === "string", "Stale release source or bundle version.");
  const policy = policyIdentitySchema.parse(distribution.policy);
  requireCheck(policy.version === "1" && policy.profiles.length === 0, "The v1 gate requires the default core v1 policy.");
  samePolicy(record.policy, policy, "Release");
  const native = object(distribution.hosts, "distribution hosts");
  const observed = uniqueRows(record.hosts, "agent", "installed hosts");
  for (const agent of ["codex", "hermes"] as const) {
    const host = observed.get(agent);
    requireCheck(host, `Missing required host ${agent}.`);
    const bundle = object(native[agent], `${agent} bundle metadata`);
    requireCheck(bundle.directory === agent && host.version === bundle.hostVersion &&
      digestSchema.safeParse(bundle.digest).success && host.bundleDigest === bundle.digest, `${agent} bundle differs.`);
    requireCheck(host.model === "gpt-6-luna" && host.os === "linux" && host.architecture === "x86_64" &&
      host.osVersion === "Ubuntu 26.04.1" && host.surface === hosts[agent], `${agent} context falls outside the qualified matrix.`);
    samePolicy(host.policy, policy, agent);
    if (agent === "codex" && host.sourceRevision !== sourceRevision) {
      const equality = object(record.codexEquivalence, "Codex artifact equivalence");
      requireCheck(typeof host.sourceRevision === "string" && revision.test(host.sourceRevision) &&
        equality.evidenceSource === host.sourceRevision && equality.releaseSource === sourceRevision &&
        equality.runtimeFiles === "byte-identical" && isDeepStrictEqual(equality.codex, bundle),
        "Codex artifact equivalence does not bind the archived and staged source.");
      samePolicy(equality.policy, policy, "Equivalent Codex artifact");
    } else {
      requireCheck(host.sourceRevision === sourceRevision, `${agent} installed evidence has stale source.`);
    }
    const lifecycle = object(host.nativeLifecycle, `${agent} native lifecycle`);
    const lifecycleSource = object(lifecycle.source, "native lifecycle source");
    const nativeHost = object(lifecycle.host, "native lifecycle host");
    requireCheck(lifecycle.kind === "installed-native-loopback" && lifecycleSource.revision === sourceRevision &&
      digestSchema.safeParse(lifecycleSource.digest).success && digestSchema.safeParse(lifecycle.receiptDigest).success &&
      nativeHost.agent === agent && nativeHost.os === host.os && nativeHost.version === host.version &&
      passed(lifecycle.transport), `${agent} native lifecycle evidence is incomplete or stale.`);
    samePolicy(lifecycle.policy, policy, `${agent} native lifecycle`);
    const transport = object(lifecycle.checks, "native lifecycle requirements");
    for (const requirement of transportRequirements) {
      requireCheck(passed(transport[requirement]), `${agent} native lifecycle requirement ${requirement} did not pass.`);
    }
    const negative = evidenceOutcomeSchema.safeParse(lifecycle.brokenControl);
    requireCheck(negative.success && (negative.data.status === "blocked" || negative.data.status === "failed"),
      `${agent} broken-install control did not reject the fixture.`);
    const cases = uniqueRows(host.cases, "kind", `${agent} cases`);
    for (const kind of Object.keys(behavior) as Array<keyof typeof behavior>) {
      const [caseId, ...criteria] = kind === "clarification" ? behavior.clarification[agent] : behavior[kind];
      const row = cases.get(kind);
      requireCheck(row && row.caseId === caseId && digestSchema.safeParse(row.archiveDigest).success,
        `${agent} is missing required case ${caseId} or its archive digest.`);
      requireCheck(row.sourceRevision === host.sourceRevision, `${agent} ${caseId} evidence is stale.`);
      const context = object(row.installedContext, `${agent} ${caseId} installed context`);
      requireCheck(context.sourceRevision === row.sourceRevision && context.bundleDigest === bundle.digest &&
        context.observedModel === host.model && typeof context.installationMechanism === "string" &&
        context.installationMechanism.length > 0 && context.installationMechanism === host.installationMechanism &&
        digestSchema.safeParse(context.admissionDigest).success &&
        (agent === "codex" ? context.nativeSkillReads === 6 :
          typeof context.passingPolicyReceipts === "number" && Number.isSafeInteger(context.passingPolicyReceipts) &&
          context.passingPolicyReceipts > 0), `${agent} ${caseId} lacks exact installed context evidence.`);
      const assertions = uniqueRows(row.assertions, "criterionId", `${caseId} assertions`);
      for (const id of criteria) {
        const assertion = assertions.get(id);
        requireCheck(assertion?.required === true && passed(assertion.outcome), `${agent} ${caseId} required assertion ${id} did not pass.`);
      }
      for (const [id, assertion] of assertions) {
        requireCheck(assertion.required === false || passed(assertion.outcome), `${agent} ${caseId} required assertion ${id} did not pass.`);
      }
      checkReceipts(row, kind);
    }
  }
  requireCheck(observed.size === 2, "Unexpected host in the v1 qualification record.");
}

/** Release-specific installation evidence must establish before, update and rollback identities. */
export function verifyRollback(input: unknown, staged: unknown): void {
  const receipt = object(input, "rollback record");
  const distribution = object(staged, "rollback candidate distribution");
  const prior = receipt.previousSourceRevision;
  requireCheck(receipt.schemaVersion === 1 && receipt.sourceRevision === distribution.sourceRevision &&
    typeof prior === "string" && revision.test(prior) && receipt.previousVersion === "0.0.9" &&
    receipt.previousVersion !== distribution.version && receipt.os === "linux" && receipt.architecture === "x86_64",
    "The rollback record has stale source, platform or versions.");
  const native = object(distribution.hosts, "rollback distribution hosts");
  const rows = uniqueRows(receipt.hosts, "agent", "rollback observations");
  for (const agent of ["codex", "hermes"] as const) {
    const row = object(rows.get(agent), `${agent} rollback observations`);
    const bundle = object(native[agent], `${agent} candidate bundle`);
    requireCheck(row.version === bundle.hostVersion, `${agent} rollback ran on the wrong host version.`);
    const before = object(row.before, `${agent} previous bundle`);
    const updated = object(row.updated, `${agent} updated bundle`);
    const restored = object(row.restored, `${agent} restored bundle`);
    requireCheck(passed(before.outcome) && before.sourceRevision === prior && before.version === receipt.previousVersion &&
      digestSchema.safeParse(before.digest).success && before.digest !== bundle.digest &&
      (agent !== "hermes" || (typeof before.commit === "string" && revision.test(before.commit) && before.commit !== bundle.commit)),
      `${agent} previous fixture bundle was not established.`);
    requireCheck(passed(updated.outcome) && updated.sourceRevision === receipt.sourceRevision &&
      updated.version === distribution.version && updated.digest === bundle.digest && updated.commit === bundle.commit,
      `${agent} update did not select the candidate bundle.`);
    samePolicy(updated.policy, policyIdentitySchema.parse(distribution.policy), `${agent} updated`);
    requireCheck(passed(restored.outcome) && restored.sourceRevision === before.sourceRevision &&
      restored.version === before.version && restored.digest === before.digest && restored.commit === before.commit,
      `${agent} restored bundle does not match the previous fixture.`);
    samePolicy(restored.policy, policyIdentitySchema.parse(before.policy), `${agent} restored`);
    requireCheck(digestSchema.safeParse(before.settingsDigest).success && updated.settingsDigest === before.settingsDigest &&
      restored.settingsDigest === before.settingsDigest, `${agent} user settings changed across update or rollback.`);
  }
  requireCheck(rows.size === 2, "Unexpected host in the v1 rollback record.");
}