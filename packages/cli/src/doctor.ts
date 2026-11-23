import { isAbsolute } from "node:path";
import type { EvidenceOutcome } from "@axiom/contracts";
import { diagnose, type Diagnosis, type DoctorRequest } from "@axiom/doctor";

export async function runDoctor(input: unknown): Promise<{ outcome: EvidenceOutcome; report?: Diagnosis }> {
  const request = input as Partial<DoctorRequest> | null;
  if (!request || typeof request.root !== "string" || !isAbsolute(request.root) || !request.catalog) {
    return { outcome: { status: "blocked", reason: "Doctor requires an absolute root and an Axiom policy catalog." } };
  }
  try {
    const report = await diagnose(request as DoctorRequest);
    const selected = report.sources.filter((source) => source.selected);
    const stages = selected.flatMap((source) => [source.installed, source.discoverable, source.loaded]);
    if (report.diagnostics.some(({ status }) => status === "failed") ||
        selected.some(({ enforced }) => enforced.status === "failed") || stages.some(({ status }) => status === "failed")) {
      return { outcome: { status: "failed", reason: "Doctor observed an invalid configuration or native state." }, report };
    }
    if (!report.host || !report.policy || !selected.length || report.diagnostics.length || stages.some(({ status }) => status !== "passed")) {
      return { outcome: { status: "blocked", reason: "Doctor could not establish complete observed activation." }, report };
    }
    return { outcome: { status: "passed" }, report };
  } catch {
    return { outcome: { status: "blocked", reason: "Doctor could not inspect the supplied catalog and native observations." } };
  }
}
