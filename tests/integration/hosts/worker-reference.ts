import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { taskBriefSchema, type EvidenceOutcome, type PolicyIdentity, type TaskBrief } from "@axiom/contracts";

interface NativeRead {
  thread: string;
  path: string;
  contents: string;
  order: number;
}

interface WorkerReferenceEvidence {
  policy: PolicyIdentity;
  parent: string;
  worker: { id: string; parent: string; startedOrder: number; completed: boolean };
  prepared: NativeRead & { digest: string };
  read: NativeRead;
  firstEdit: { thread: string; order: number };
}

type ReferenceIdentity = Omit<WorkerReferenceEvidence, "prepared" | "read" | "firstEdit">;

interface CommandObservation {
  event: string;
  session: string;
  agent?: string;
  turn: string;
  id: string;
  cwd: string;
  command?: string;
  startedAt: string;
  source: { digest: string };
  reference?: { operation: "sha256sum" | "cat"; path: string; contents: string; digest: string };
}

/** Match independently captured command events to the native child linked in the session archive. */
export function reviewWorkerReference(identity: ReferenceIdentity, workspace: string, observations: readonly CommandObservation[]) {
  const index = new Map<string, CommandObservation[]>();
  const threadOf = (row: CommandObservation) => row.agent ?? row.session;
  for (const row of observations) {
    const key = JSON.stringify([threadOf(row), row.turn, row.id]);
    const pair = index.get(key) ?? [];
    pair.push(row);
    index.set(key, pair);
  }
  const pairs = [...index.values()].flatMap(([pre, post, ...duplicates]) =>
    pre && post && duplicates.length === 0 && pre.event === "PreToolUse" && post.event === "PostToolUse"
      && pre.command === post.command && pre.cwd === workspace && post.cwd === workspace
      && Date.parse(pre.startedAt) <= Date.parse(post.startedAt) ? [{ pre, post }] : []);
  const workerEvents = observations.filter((row) => threadOf(row) === identity.worker.id);
  const workerPairs = pairs.filter(({ post }) => threadOf(post) === identity.worker.id);
  if (workerEvents.length !== 2 * workerPairs.length) {
    return { outcome: { status: "blocked", reason: "The worker command observations were incomplete." } } as const;
  }
  const edits = workerPairs.filter(({ pre, post }) => pre.source.digest !== post.source.digest);
  const edit = edits.sort((a, b) => Date.parse(a.pre.startedAt) - Date.parse(b.pre.startedAt))[0]?.pre;
  const stable = pairs.flatMap(({ pre, post }) => pre.source.digest === post.source.digest && post.reference
    ? [{ ...post.reference, thread: threadOf(post), order: Date.parse(post.startedAt) }] : []);
  const read = stable.find(({ operation, thread }) => operation === "cat" && thread === identity.worker.id);
  const prepared = stable.find(({ operation, thread, path }) =>
    operation === "sha256sum" && thread === identity.parent && path === read?.path);
  if (!prepared || !read || !edit) {
    return { outcome: { status: "blocked", reason: "The required native digest, read, or edit receipt is missing." } } as const;
  }
  return verifyWorkerReference({ ...identity, prepared, read, firstEdit: { thread: threadOf(edit), order: Date.parse(edit.startedAt) } });
}

/** Verify a native lookup. The verifier collects the two byte observations outside the tool workspace. */
export function verifyWorkerReference({ policy, parent, worker, prepared, read, firstEdit }: WorkerReferenceEvidence):
{ outcome: EvidenceOutcome; brief?: TaskBrief } {
  if (!parent || !worker.id || parent === worker.id || worker.parent !== parent || !worker.completed ||
      prepared.thread !== parent || read.thread !== worker.id || firstEdit.thread !== worker.id) {
    return { outcome: { status: "blocked", reason: "The native worker, parent and read could not be linked." } };
  }
  const sequence = [prepared.order, worker.startedOrder, read.order, firstEdit.order];
  if (!sequence.every((order, index) => Number.isSafeInteger(order) && order >= 0 &&
      (index === 0 || sequence[index - 1]! < order))) {
    return { outcome: { status: "failed", reason: "The referenced brief was not observed before the worker's first edit." } };
  }
  const { path } = prepared;
  const digest = "sha256:" + createHash("sha256").update(prepared.contents).digest("hex");
  if (!path || path.includes("\\") || path.includes("\0") || posix.isAbsolute(path) ||
      posix.normalize(path) !== path || path.split("/").includes("..") || path === "." ||
      read.path !== path || read.contents !== prepared.contents || prepared.digest !== digest) {
    return { outcome: { status: "failed", reason: "The worker's observed brief differs from the digest-bound parent artifact." } };
  }
  try {
    const brief = taskBriefSchema.parse(JSON.parse(read.contents));
    if (brief.parentId && brief.parentId !== brief.id && isDeepStrictEqual(brief.policy, policy)) {
      return { outcome: { status: "passed" }, brief };
    }
  } catch {
    // A readable file alone cannot establish the typed handoff.
  }
  return { outcome: { status: "failed", reason: "The observed brief did not preserve its task lineage and selected policy." } };
}
