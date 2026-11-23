import { checkHermesEvent } from "./hooks.js";
import { basename, dirname } from "node:path";

const [, , directory, archive, event, session] = process.argv;
const profile = directory ? dirname(dirname(directory)) : "";
const result = directory && archive && event === "pre-tool"
  ? await checkHermesEvent(directory, archive, event, {
    profile: { home: dirname(dirname(profile)), profile: basename(profile) }, session: session ?? "",
  })
  : { outcome: { status: "blocked", reason: "The Hermes hook invocation is invalid." } };
console.log(JSON.stringify(result.outcome));
