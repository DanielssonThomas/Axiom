import { isAbsolute } from "node:path";
import { runBenchmark, type BenchmarkOptions, type BenchmarkReport } from "@axiom/benchmark";
import { hostIdentitySchema, type EvidenceOutcome } from "@axiom/contracts";
import { EvidenceStore } from "@axiom/evidence";

type BenchmarkRequest = Omit<BenchmarkOptions, "store" | "signal"> & { evidenceDirectory: string };

export async function runBenchmarkRequest(agent: string, input: unknown): Promise<{ outcome: EvidenceOutcome; report?: BenchmarkReport }> {
  const request = input as Partial<BenchmarkRequest> | null;
  const host = hostIdentitySchema.safeParse(request?.host);
  if (!request || !host.success || host.data.agent !== agent ||
      typeof request.fixtureRoot !== "string" || !isAbsolute(request.fixtureRoot) ||
      typeof request.evidenceDirectory !== "string" || !isAbsolute(request.evidenceDirectory) ||
      typeof request.grader?.grade !== "function") {
    return { outcome: { status: "blocked", reason: "The benchmark request needs matching host, fixture, archive, and grader settings." } };
  }
  try {
    const { evidenceDirectory, ...options } = request as BenchmarkRequest;
    const report = await runBenchmark({ ...options, store: new EvidenceStore(evidenceDirectory) });
    if (report.outcome.status !== "passed") return { outcome: report.outcome, report };
    if (report.attempts.some((attempt) => attempt.runtime !== "isolated" || !attempt.execution?.host ||
        !attempt.assertions.some((assertion) => assertion.required) ||
        attempt.assertions.some((assertion) => assertion.required && !assertion.evidenceId))) {
      return { outcome: { status: "blocked", reason: "Benchmark conformance requires isolated native execution and observed required evidence for each attempt." }, report };
    }
    return { outcome: report.outcome, report };
  } catch {
    return { outcome: { status: "blocked", reason: "The benchmark request or evidence archive could not be processed." } };
  }
}
