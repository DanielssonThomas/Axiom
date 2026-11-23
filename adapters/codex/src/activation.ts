import type { Capability, EvidenceOutcome, HostIdentity } from "@axiom/contracts";
import { assessPolicy, resolvePolicy, type CheckObservation, type InstructionConflict, type PolicyCatalog } from "@axiom/policy";
import type { CodexBundle } from "./bundle.js";

export const supportedVersion = "0.172.0-alpha.2";

function supports(host: Pick<HostIdentity, "agent" | "version" | "os" | "surface">): boolean {
  return host.agent === "codex" && host.surface === "cli" && host.os === "linux" && host.version === supportedVersion;
}

export function codexCapabilities(host: HostIdentity): Capability[] {
  const recognized = supports(host);
  return [
    ...["plugin-discovery", "policy-loading", "process-execution", "action-trace"].map((id): Capability => recognized
      ? { id, available: true }
      : { id, available: false, reason: "This Codex surface, version, or OS is unsupported." }),
    ...["startup-hook", "resume", "compaction", "delegation", "hook-enforcement"].map((id): Capability => ({
      id, available: false, reason: `Observable ${id} coverage is unavailable for this adapter surface.`,
    })),
  ];
}

export interface CodexActivationInput {
  bundle: CodexBundle;
  host: HostIdentity;
  catalog: PolicyCatalog;
  observations: readonly CheckObservation[];
  observedVersion?: string;
  discovered: boolean;
  selected: boolean;
  /** Text extracted from the host's instruction surface and host skill inventory. */
  contexts: readonly string[];
  skills: readonly string[];
  conflicts?: readonly InstructionConflict[];
  requiredCapabilities?: readonly string[];
}

/** Independently classify native activation and evaluate applicable shared policy checks. */
export function assessCodexActivation(input: CodexActivationInput) {
  const { bundle, host, catalog, observations, discovered, selected, contexts, skills } = input;
  const active = contexts.some((context) => context.includes(bundle.instructions)) &&
    bundle.skills.every((name) => skills.includes(`axiom:${name}`));
  const resolution = resolvePolicy(catalog, bundle.policy.profiles.map(({ id }) => id), input.conflicts);
  const assessment = assessPolicy(resolution, observations);
  const capabilities = codexCapabilities(host);
  const unavailable = input.requiredCapabilities?.find((id) =>
    !capabilities.some((capability) => capability.id === id && capability.available));
  let outcome: EvidenceOutcome = assessment.outcome;

  if (!supports(host) || input.observedVersion !== host.version) {
    outcome = { status: "blocked", reason: "The native Codex CLI surface or observed version is unsupported." };
  } else if (!discovered || !selected || !active) {
    outcome = { status: "blocked", reason: "The plugin, selected policy, or native context loading was not observed." };
  } else if (resolution.policy?.identity.digest !== bundle.policy.digest) {
    outcome = { status: "blocked", reason: "The selected policy digest does not match the bundled policy." };
  } else if (unavailable) {
    outcome = { status: "blocked", reason: `Required Codex capability is unavailable: ${unavailable}.` };
  }
  return { discovery: discovered, selection: selected, loading: active, policyDigest: bundle.policy.digest, capabilities, assessment, outcome };
}

export function supportedCodexHost(host: HostIdentity): boolean {
  return supports(host);
}
