#!/usr/bin/env node

import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { EvidenceOutcome } from "@axiom/contracts";
import { runBenchmarkRequest } from "./benchmark.js";
import { runCheck } from "./check.js";
import { runDoctor } from "./doctor.js";

type Command = { command: "doctor" | "check" } | { command: "benchmark"; agent: string };

function parseCommand(args: readonly string[]): { command: Command; requestPath?: string } | undefined {
  const flag = args.indexOf("--request");
  const requestPath = flag === -1 ? undefined : args[flag + 1];
  if (flag !== -1 && (flag !== args.length - 2 || !requestPath || !isAbsolute(requestPath) || !requestPath.endsWith(".mjs"))) {
    return;
  }
  const positional = flag === -1 ? args : args.slice(0, flag);
  const [command, agent] = positional;
  const request = requestPath === undefined ? {} : { requestPath };
  if (positional.length === 1 && (command === "doctor" || command === "check")) {
    return { command: { command }, ...request };
  }
  if (positional.length === 2 && (command === "benchmark" || command === "--benchmark") && agent && !/^-|\s/.test(agent)) {
    return { command: { command: "benchmark", agent }, ...request };
  }
}

async function execute(command: Command, path?: string): Promise<{ outcome: EvidenceOutcome; report?: unknown }> {
  if (path === undefined) return { outcome: { status: "blocked", reason: "Supply a trusted operator request with --request." } };
  let request: unknown;
  try {
    const exports = await import(pathToFileURL(path).href) as Record<string, unknown>;
    request = exports[command.command];
  } catch {
    return { outcome: { status: "blocked", reason: "The trusted operator request could not be loaded." } };
  }
  if (request === undefined) return { outcome: { status: "blocked", reason: "The file does not export the requested operation." } };
  switch (command.command) {
    case "doctor": return runDoctor(request);
    case "check": return runCheck(request);
    case "benchmark": return runBenchmarkRequest(command.agent, request);
  }
}

const parsed = parseCommand(process.argv.slice(2));
if (!parsed) {
  console.log(JSON.stringify({
    status: "failed",
    reason: "Usage: axiom (doctor | check | benchmark <agent> | --benchmark <agent>) [--request /absolute/path.mjs]",
  }));
  process.exitCode = 2;
} else {
  const { outcome, report } = await execute(parsed.command, parsed.requestPath);
  console.log(JSON.stringify({ ...parsed.command, ...outcome, ...(report === undefined ? {} : { report }) }));
  process.exitCode = outcome.status === "passed" ? 0 : 1;
}
