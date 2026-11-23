import { resolvePolicy } from "@axiom/policy";
import type { ActivationObservation, Diagnosis, DoctorRequest } from "./model.js";
import { activationObservationSchema, doctorConfigSchema } from "./model.js";
import { inspectSource, inspectSourceSelection } from "./source.js";

export { activationObservationSchema, doctorConfigSchema } from "./model.js";
export type { ActivationObservation, Diagnosis, Diagnostic, DoctorRequest, SourceDiagnosis } from "./model.js";

/** Inspect native configuration inputs and independently observed stages without changing them. */
export async function diagnose(request: DoctorRequest): Promise<Diagnosis> {
  const report: Diagnosis = { diagnostics: [], sources: [], capabilities: [] };
  const parsed = doctorConfigSchema.safeParse(request.config);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      report.diagnostics.push({
        code: "invalid_config", subject: issue.path.map(String).join(".") || "configuration", status: "failed",
        reason: issue.message,
        remediation: "Correct the affected field in the native configuration and collect a new snapshot.",
      });
    }
    return report;
  }

  const config = parsed.data;
  report.capabilities = config.capabilities;
  if (config.host) report.host = config.host;

  const resolution = resolvePolicy(request.catalog, config.profiles.map(({ id }) => id), request.instructionConflicts);
  if (resolution.policy) report.policy = resolution.policy;
  for (const diagnostic of resolution.diagnostics) {
    const code = diagnostic.code;
    report.diagnostics.push({
      code, subject: diagnostic.path,
      status: code === "instruction_conflict" || code === "incompatible_requirement" ? "blocked" : "failed",
      reason: diagnostic.field ? `${diagnostic.field}: ${diagnostic.message}` : diagnostic.message,
      remediation: "Resolve the reported definition or selection against the native instruction hierarchy.",
    });
  }
  for (const profile of config.profiles) {
    const effective = report.policy?.identity.profiles.find(({ id }) => profile.id === id);
    if (effective && effective.version !== profile.version) {
      report.diagnostics.push({
        code: "profile_version", subject: profile.id, status: "failed",
        reason: `Selected version ${profile.version} differs from resolved version ${effective.version}.`,
        remediation: "Select a compatible profile version or update the installed bundle.",
      });
    }
  }
  if (config.supportedHostVersions && (!config.host || !config.supportedHostVersions.includes(config.host.version))) {
    report.diagnostics.push({
      code: "host_version", subject: config.host?.agent ?? "host", status: config.host ? "failed" : "blocked",
      reason: config.host ? `Host version ${config.host.version} is outside the declared compatibility set.`
        : "No observed host version is available for the compatibility check.",
      remediation: "Check the actual host version and choose an integration package declared for it.",
    });
  }
  for (const capability of config.capabilities) {
    if (!capability.available) {
      report.diagnostics.push({
        code: "capability_gap", subject: capability.id, status: "blocked", reason: capability.reason,
        remediation: "Check the adapter and host documentation for a surface or setting that supports this capability.",
      });
    }
  }

  const observations = new Map<string, ActivationObservation>();
  const ambiguous = new Set<string>();
  for (const raw of request.observations ?? []) {
    const parsed = activationObservationSchema.safeParse(raw);
    if (!parsed.success) {
      report.diagnostics.push({
        code: "invalid_observation", subject: "adapter", status: "failed",
        reason: "The native observation lacks a valid source identity or stage outcome.",
        remediation: "Collect a new observation through the native adapter.",
      });
      continue;
    }
    const observation = parsed.data;
    if (observations.has(observation.path)) ambiguous.add(observation.path);
    observations.set(observation.path, observation);
  }
  for (const path of ambiguous) {
    observations.delete(path);
    report.diagnostics.push({
      code: "ambiguous_observation", subject: path, status: "blocked",
      reason: "Multiple observations were supplied for the same native source.",
      remediation: "Select the observation for the current host and source state.",
    });
  }
  for (const source of config.sources) {
    report.sources.push(await inspectSource(request.root, source, observations.get(source.path), config.host, report.diagnostics));
  }
  inspectSourceSelection(report.sources, report.diagnostics);
  return report;
}

export function formatDiagnosis(report: Diagnosis): string {
  const lines = ["Axiom configuration diagnostics"];
  if (report.host) lines.push(`Host ${report.host.agent} ${report.host.version} (${report.host.surface})`);
  if (report.policy) {
    const { version, digest, profiles } = report.policy.identity;
    lines.push(`Policy ${version} (${digest})`);
    lines.push(`Profiles ${profiles.map(({ id, version }) => `${id}@${version}`).join(", ") || "none"}`);
    lines.push(`Principles ${report.policy.principles.map(({ id, version }) => `${id}@${version}`).join(", ")}`);
  }
  for (const source of report.sources) {
    lines.push(`${source.kind} ${source.id} at ${source.path}`);
    if (source.mechanism) lines.push(`  Native evidence from ${source.mechanism}`);
    for (const stage of ["installed", "discoverable", "loaded", "enforced"] as const) {
      const outcome = source[stage];
      lines.push(`  ${stage} ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`);
    }
  }
  for (const capability of report.capabilities) {
    lines.push(`Capability ${capability.id} ${capability.available ? "available" : capability.reason}`);
  }
  for (const { code, subject, status, reason, remediation } of report.diagnostics) {
    lines.push(`[${status}] ${subject} (${code}) ${reason} ${remediation}`);
  }
  return lines.join("\n") + "\n";
}
