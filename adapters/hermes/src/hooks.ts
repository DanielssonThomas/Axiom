import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { evidenceSchema } from "@axiom/contracts";
import type { Evidence, EvidenceOutcome } from "@axiom/contracts";
import { EvidenceStore } from "@axiom/evidence";
import { assessPolicy } from "@axiom/policy";
import { digest, readBundle, verifyBundle } from "./bundle.js";
import { inspectHermesActivation } from "./profile.js";
import type { HermesProfile } from "./profile.js";

const checkId = "hermes-bundle-integrity";

export type HermesEvent = "pre-tool" | "resume" | "compaction" | "delegation";

interface HookObservation {
  outcome: EvidenceOutcome;
  evidence?: Evidence;
}

/** Assess the installed policy payload and retain the observed check through the shared archive. */
export async function checkHermesEvent(
  directory: string, archive: string, event: HermesEvent, native?: { profile: HermesProfile; session: string },
): Promise<HookObservation> {
  const started = new Date();
  let manifest;
  let root;
  try {
    root = realpathSync(directory);
    manifest = readBundle(root);
  } catch {
    return { outcome: { status: "blocked", reason: "The installed Hermes bundle identity could not be read." } };
  }
  let outcome: EvidenceOutcome;
  if (event !== "pre-tool") {
    outcome = { status: "blocked", reason: `Required Hermes ${event} coverage is unsupported by this adapter.` };
  } else {
    let observed: EvidenceOutcome;
    try {
      verifyBundle(root, manifest);
      observed = { status: "passed" };
    } catch (error) {
      observed = { status: "failed", reason: error instanceof Error ? error.message : "Bundle check failed." };
    }
    if (native && observed.status === "passed") {
      const activation = inspectHermesActivation(native.profile, native.session);
      if (activation.policy?.digest !== manifest.policy.digest || activation.coreLoaded.status !== "passed") {
        observed = { status: "blocked", reason: "Required Axiom core loading is absent in the current Hermes session." };
      }
    }
    const assessment = assessPolicy({
      diagnostics: [],
      policy: {
        identity: manifest.policy, principles: [], profiles: [],
        requirements: [{ id: checkId, kind: "mechanical", required: true,
          principleIds: ["AX-03"], origins: [{ kind: "core", path: "axiom-bundle.json" }] }],
      },
    }, [{ id: checkId, kind: "mechanical", outcome: observed }]).outcome;
    outcome = observed.status === "blocked" ? observed : assessment;
  }

  try {
    const paths = manifest.files.map(({ path }) => {
      try {
        const candidate = join(root, path);
        return [path, realpathSync(candidate) === candidate ? digest(readFileSync(candidate)) : "redirected"];
      } catch {
        return [path, "unavailable"];
      }
    });
    const evidence = evidenceSchema.parse({
      id: "hermes-hook-" + randomUUID(), taskId: "hermes-lifecycle", criterionIds: [`hermes-${event}`],
      policy: manifest.policy, source: { digest: digest(JSON.stringify([manifest.digest, paths])) },
      startedAt: started.toISOString(), durationMs: Date.now() - started.getTime(),
      provenance: "observed", artifacts: [], outcome,
    });
    await new EvidenceStore(archive).record("acceptance", evidence);
    return { outcome, evidence };
  } catch {
    return { outcome: { status: "blocked", reason: "The Hermes lifecycle evidence archive could not be written." } };
  }
}
