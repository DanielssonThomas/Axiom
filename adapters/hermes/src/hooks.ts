import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { evidenceSchema, taskBriefSchema } from "@axiom/contracts";
import { isDeepStrictEqual } from "node:util";
import type { Evidence, EvidenceOutcome } from "@axiom/contracts";
import { EvidenceStore } from "@axiom/evidence";
import { assessPolicy } from "@axiom/policy";
import { digest, readBundle, verifyBundle } from "./bundle.js";
import { formatHermesWorkerContext, inspectHermesActivation } from "./profile.js";
import type { HermesProfile } from "./profile.js";

const checkId = "hermes-bundle-integrity";

export type HermesEvent = "pre-tool" | "resume" | "compaction" | "delegation";

interface HookObservation {
  outcome: EvidenceOutcome;
  evidence?: Evidence;
  workerBriefCorrection?: string;
  workerBriefPatches?: Array<{ context: string; notes: string } | null>;
}

const briefFields = new Set(Object.keys(taskBriefSchema.shape));

/** Keep the first complete JSON object and retain any separate native task notes. */
export function parseHermesWorkerBrief(body: string) {
  const input = body.trimStart();
  if (input[0] !== "{") throw new Error("Expected a JSON worker brief.");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      const entries = Object.entries(JSON.parse(input.slice(0, index + 1)));
      const brief = taskBriefSchema.parse(Object.fromEntries(entries.filter(([key]) => briefFields.has(key))));
      const extra = entries.filter(([key]) => !briefFields.has(key));
      const trailing = input.slice(index + 1).trim();
      const notes = [extra.length ? JSON.stringify(Object.fromEntries(extra)) : "", trailing].filter(Boolean).join("\n\n");
      return { brief, notes };
    }
  }
  throw new Error("Expected a complete JSON worker brief.");
}

function checkWorkerBriefs(contexts: readonly string[], policy: Evidence["policy"]) {
  const patches: NonNullable<HookObservation["workerBriefPatches"]> = [];
  try {
    for (const context of contexts) {
      const { brief, notes } = parseHermesWorkerBrief(context);
      if (!brief.parentId || brief.parentId === brief.id || !isDeepStrictEqual(brief.policy, policy)) {
        throw new Error("Worker brief names a different policy or omits parent lineage.");
      }
      patches.push(notes ? { context: formatHermesWorkerContext(brief), notes } : null);
    }
    return patches.some(Boolean) ? { workerBriefPatches: patches } : {};
  } catch {
    return { workerBriefCorrection: "Provide the complete Axiom worker brief in the marked context before launching. "
      + "Assign a distinct local worker id and copy the actual parentId. Include objective, ownedPaths, criteria, requiredCapabilities and limits. "
      + "Use process-execution for running verification commands. Copy policy with its exact version, digest and profiles." };
  }
}

/** Assess the installed policy payload and retain the observed check through the shared archive. */
export async function checkHermesEvent(
  directory: string, archive: string, event: HermesEvent,
  native?: { profile: HermesProfile; session: string; workerBriefs?: readonly string[] },
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
    const workerBrief = outcome.status === "passed" && native?.workerBriefs?.length
      ? checkWorkerBriefs(native.workerBriefs, manifest.policy) : {};
    return { outcome, evidence, ...workerBrief };
  } catch {
    return { outcome: { status: "blocked", reason: "The Hermes lifecycle evidence archive could not be written." } };
  }
}
