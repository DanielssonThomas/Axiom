import { checkHermesEvent } from "./hooks.js";
import { basename, dirname } from "node:path";

const [, , directory, archive, event, session] = process.argv;
const profile = directory ? dirname(dirname(directory)) : "";
process.stdin.setEncoding("utf8");
let payload = "";
for await (const chunk of process.stdin) {
  payload += chunk;
  if (payload.length > 256_000) break;
}
let workerBriefs: readonly string[] | undefined;
if (payload) {
  try {
    const briefInputs: unknown = payload.length <= 256_000 ? JSON.parse(payload) : undefined;
    workerBriefs = Array.isArray(briefInputs) && briefInputs.every((item) => typeof item === "string") ? briefInputs : [""];
  } catch {
    workerBriefs = [""];
  }
}
const result = directory && archive && event === "pre-tool"
  ? await checkHermesEvent(directory, archive, event, {
    profile: { home: dirname(dirname(profile)), profile: basename(profile) }, session: session ?? "",
    ...(workerBriefs && { workerBriefs }),
  })
  : { outcome: { status: "blocked", reason: "The Hermes hook invocation is invalid." } };
console.log(JSON.stringify({ ...result.outcome,
  ...("workerBriefCorrection" in result && { workerBriefCorrection: result.workerBriefCorrection }) }));
