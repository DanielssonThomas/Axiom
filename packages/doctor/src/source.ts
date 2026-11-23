import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { EvidenceOutcome, HostIdentity } from "@axiom/contracts";
import type { ActivationObservation, ConfiguredSource, Diagnostic, SourceDiagnosis } from "./model.js";

function absentStage(): EvidenceOutcome {
  return { status: "not_run", reason: "No matching native observation was recorded." };
}

async function inspectFile(root: string, source: ConfiguredSource): Promise<string> {
  const path = resolve(root, source.path);
  const file = await stat(path);
  if (!file.isFile()) throw new Error("Expected a regular instruction or skill file.");
  return "sha256:" + createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function inspectSource(
  root: string,
  source: ConfiguredSource,
  observation: ActivationObservation | undefined,
  host: HostIdentity | undefined,
  diagnostics: Diagnostic[],
): Promise<SourceDiagnosis> {
  const result: SourceDiagnosis = {
    ...source,
    installed: { status: "passed" },
    discoverable: absentStage(),
    loaded: absentStage(),
    enforced: absentStage(),
  };
  let digest: string;
  try {
    digest = await inspectFile(root, source);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    const reason = missing ? "The configured source does not exist." : "The configured source is not a readable file.";
    result.installed = { status: "blocked", reason };
    diagnostics.push({
      code: missing ? "missing_source" : "unreadable_source",
      subject: source.path, status: "blocked", reason,
      remediation: "Check the source path and access in the native configuration.",
    });
    return result;
  }

  result.observedDigest = digest;
  if (source.digest && source.digest !== digest) {
    diagnostics.push({
      code: "content_drift", subject: source.path, status: "failed",
      reason: "The file content differs from the expected digest.",
      remediation: "Compare the source with the intended installed bundle and reconcile its content or declared identity.",
    });
  }
  if (!observation) return result;

  const stages = ["discoverable", "loaded", "enforced"] as const;
  const hostMatches = isDeepStrictEqual(observation.host, host);
  if (!hostMatches || observation.digest !== digest) {
    const reason = hostMatches ? "The recorded native observation refers to different content."
      : "The recorded native observation refers to a different host identity.";
    for (const stage of stages) {
      if (observation.stages[stage]) result[stage] = { status: "blocked", reason };
    }
    diagnostics.push({
      code: "stale_observation", subject: source.path, status: "blocked", reason,
      remediation: "Collect a fresh observation for the current host and file.",
    });
    return result;
  }
  result.mechanism = observation.mechanism;
  for (const stage of stages) {
    result[stage] = observation.stages[stage] ?? result[stage];
  }
  return result;
}

export function inspectSourceSelection(sources: readonly ConfiguredSource[], diagnostics: Diagnostic[]): void {
  const groups = new Map<string, ConfiguredSource[]>();
  for (const source of sources) {
    const key = source.kind + "/" + source.id;
    const group = groups.get(key) ?? [];
    group.push(source);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const selected = group.filter((source) => source.selected);
    if (selected.length > 1) {
      diagnostics.push({
        code: "conflicting_sources", subject: selected[0]!.id, status: "blocked",
        reason: `Multiple native sources are selected: ${selected.map(({ path }) => path).join(", ")}.`,
        remediation: "Resolve the conflicting selections using the host's native configuration.",
      });
      continue;
    }
    const [active] = selected;
    if (!active) continue;
    for (const source of group) {
      if (source.selected) continue;
      diagnostics.push({
        code: "shadowed_source", subject: source.path, status: "blocked",
        reason: `The native selection points to ${active.path}.`,
        remediation: "Check the host's configured scopes and keep its intended source selected.",
      });
    }
  }
}
