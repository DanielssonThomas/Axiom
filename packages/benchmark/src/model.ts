import type {
  BackendRequest, BackendResult, BenchmarkBackend, Capability, EvaluationCase, EvidenceOutcome,
  HostIdentity, PolicyIdentity, RunLimits, SourceIdentity,
} from "@axiom/contracts";
import type { EvidenceStore } from "@axiom/evidence";

export interface BenchmarkRuntime {
  /** Fixture runtimes use trusted test doubles. Native runtimes require enforced process isolation. */
  readonly kind: "fixture" | "isolated";
  /** Workspace path as mounted and visible to the backend. */
  readonly workspace: string;
  readonly backend: BenchmarkBackend;
  /** Stop the runtime, flush curated observations and revoke access before returning. */
  close(signal: AbortSignal): Promise<void>;
}

/** The provider must expose only the staged workspace and explicitly approved runtime resources. */
export type OpenBenchmarkRuntime = (stagedWorkspace: string, signal: AbortSignal) => Promise<BenchmarkRuntime>;

export interface BenchmarkObservation {
  readonly before: ReadonlyMap<string, string>;
  readonly after: ReadonlyMap<string, string>;
  readonly source: SourceIdentity;
  readonly policy: PolicyIdentity;
  readonly execution: BackendResult;
}

export interface BenchmarkGrading {
  readonly source: SourceIdentity;
  readonly assertions: readonly { readonly criterionId: string; readonly outcome: EvidenceOutcome }[];
}

export interface BenchmarkGrader {
  readonly version: string;
  readonly digest: string;
  /** Verifier-side grading. Resolve trusted observations from curated execution artifacts here. */
  grade(
    evaluation: EvaluationCase,
    observation: BenchmarkObservation,
    signal: AbortSignal,
  ): BenchmarkGrading | Promise<BenchmarkGrading>;
}

export interface BenchmarkOptions {
  readonly fixtureRoot: string;
  readonly catalog: readonly unknown[];
  readonly caseIds: readonly string[];
  readonly host: HostIdentity;
  readonly policy: PolicyIdentity;
  readonly capabilities: readonly Capability[];
  readonly limits: RunLimits;
  readonly repetitions: number;
  readonly openRuntime?: OpenBenchmarkRuntime;
  readonly grader: BenchmarkGrader;
  readonly store: EvidenceStore;
  readonly signal?: AbortSignal;
}

export interface BenchmarkAssertion {
  readonly id: string;
  readonly grader: string;
  readonly required: boolean;
  outcome: EvidenceOutcome;
  evidenceId?: string;
}

export interface BenchmarkAttempt {
  readonly id: string;
  readonly case: Pick<EvaluationCase, "id" | "version" | "skill" | "profiles" | "principleIds">;
  readonly mode: BackendRequest["mode"];
  readonly repetition: number;
  runtime?: BenchmarkRuntime["kind"];
  execution?: BackendResult;
  source?: SourceIdentity;
  assertions: BenchmarkAssertion[];
  outcome: EvidenceOutcome;
}

export interface BenchmarkReport {
  readonly host: HostIdentity;
  readonly policy: PolicyIdentity;
  readonly grader: Pick<BenchmarkGrader, "version" | "digest">;
  readonly limits: RunLimits;
  readonly attempts: BenchmarkAttempt[];
  readonly outcome: EvidenceOutcome;
}

export const blocked = (reason: string): EvidenceOutcome => ({ status: "blocked", reason });
export const notRun = (reason: string): EvidenceOutcome => ({ status: "not_run", reason });
