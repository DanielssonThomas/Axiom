import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BenchmarkObservation } from "@axiom/benchmark";
import type { EvaluationCase, Evidence } from "@axiom/contracts";
import type { EvidenceStore } from "@axiom/evidence";
import { unavailablePreviewCase, type GradingAction } from "@axiom/graders";
import { sha256 } from "./reviewed-baseline.js";

export function isUnavailablePreview(evaluation: { id: string; version: string }) {
  return evaluation.id === unavailablePreviewCase.id && evaluation.version === unavailablePreviewCase.version;
}

export function supportsNativePreview(evaluation: EvaluationCase) {
  const required = evaluation.assertions.filter(({ required }) => required);
  return isUnavailablePreview(evaluation) && required.length === 1 && required[0]?.grader === unavailablePreviewCase.grader &&
    isDeepStrictEqual(evaluation.requiredCapabilities, ["action-trace"]);
}

export async function recordUnavailablePreview(store: EvidenceStore, value: BenchmarkObservation,
  artifacts: Evidence["artifacts"] = []): Promise<GradingAction> {
  const id = value.execution.requestId;
  const evidence: Evidence = {
    id: `${id}.preview-capability`, taskId: id, criterionIds: [unavailablePreviewCase.criterion],
    source: value.source, policy: value.policy, host: value.execution.host, provenance: "observed",
    startedAt: new Date().toISOString(), durationMs: 0, artifacts,
    outcome: { status: "blocked", reason: "The fixture has no running browser preview." },
  };
  await store.record("acceptance", evidence);
  return { kind: "check", evidence };
}

export async function nativePreviewActions(store: EvidenceStore, value: BenchmarkObservation) {
  const { artifacts, host, requestId } = value.execution;
  const receipt = artifacts.find(({ kind }) => kind === "native-preview-boundary");
  if (!receipt?.digest || receipt.location !== `${requestId}.preview.json`) return;
  const boundary = host?.agent === "codex" ? { requestId, mcpServers: 0, networkNamespace: "isolated" }
    : host?.agent === "hermes" ? { requestId, enabledToolsets: ["file", "skills"], browser: "disabled" } : undefined;
  if (!boundary) return;
  const bytes = await readFile(join(store.directory, receipt.location));
  if (receipt.digest !== sha256(bytes) || !isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), boundary)) return;
  return [await recordUnavailablePreview(store, value, [receipt])];
}
