#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EvidenceOutcome } from "@axiom/contracts";
import { runBenchmarkRequest } from "./benchmark.js";
import { runBenchmarkPreflight } from "./benchmark-preflight.js";
import { reviewNativeBenchmark } from "./benchmark-review.js";
import { runCheck } from "./check.js";
import { runDoctor } from "./doctor.js";
import { defaultBenchmarkLimits, runNativeBenchmark } from "./native-benchmark.js";
import { runStandardBenchmark } from "./standard-benchmark.js";
import { runCodexLifecycle, runNativeBundle } from "./native-install.js";

type Result = { outcome: EvidenceOutcome; report?: unknown };
type Operation = { summary: Record<string, string>; run(signal: AbortSignal): Promise<Result> };

function options(args: readonly string[], valueNames: readonly string[], repeat?: string, toggles: readonly string[] = []) {
  const found = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (found.has(key) && key !== repeat) return;
    if (toggles.includes(key)) {
      found.set(key, []);
    } else {
      const value = args[++i];
      if (!valueNames.includes(key) || !value || value.startsWith("--")) return;
      found.set(key, [...found.get(key) ?? [], value]);
    }
  }
  return {
    get: (name: string) => found.get(name)?.[0],
    all: (name: string) => found.get(name),
    has: (name: string) => found.has(name),
  };
}

async function operatorRequest(command: string, path: string | undefined, agent?: string): Promise<Result> {
  if (!path) return { outcome: { status: "blocked", reason: "Supply a trusted operator request with --request." } };
  let request: unknown;
  try {
    const exports = await import(pathToFileURL(path).href) as Record<string, unknown>;
    request = exports[command];
  } catch {
    return { outcome: { status: "blocked", reason: "The trusted operator request could not be loaded." } };
  }
  if (request === undefined) return { outcome: { status: "blocked", reason: "The file does not export the requested operation." } };
  if (command === "doctor") return runDoctor(request);
  if (command === "check") return runCheck(request);
  return runBenchmarkRequest(agent!, request);
}

function parse(args: readonly string[]): Operation | undefined {
  const [command, ...rest] = args;
  const expert = (name: string, arg: readonly string[], agent?: string): Operation | undefined => {
    const choice = options(arg, ["--request"], undefined, name === "benchmark" ? ["--allow-paid"] : []);
    const request = choice?.get("--request");
    if (!choice || (request !== undefined && (!isAbsolute(request) || !request.endsWith(".mjs")))) return;
    return { summary: { command: name, ...(agent ? { agent } : {}) }, run: async () =>
      name === "benchmark" && !choice.has("--allow-paid")
        ? { outcome: { status: "blocked", reason: "Authorize operator benchmark execution explicitly with --allow-paid." } }
        : operatorRequest(name, request, agent) };
  };
  if (command === "doctor" || command === "check") return expert(command, rest);
  if (command === "benchmark" || command === "--benchmark") {
    const [agent, ...args] = rest;
    if (!agent || /^-|\s/.test(agent)) return;
    if (args.includes("--request")) return expert("benchmark", args, agent);
    const flags = options(args, ["--mode", "--auth-home", "--program", "--model", "--evidence", "--baseline", "--case",
      "--token-budget", "--max-output-tokens", "--timeout-seconds", "--repetitions", "--max-attempts"],
    "--case", ["--allow-paid", "--allow-native", "--preflight"]);
    if (!flags) return;
    const mode = flags.get("--mode") ?? "strict";
    if (mode !== "standard" && mode !== "strict") return;
    if (mode === "standard" ? ["--allow-paid", "--token-budget", "--max-output-tokens"].some(flags.has)
      : ["--allow-native", "--auth-home", "--max-attempts"].some(flags.has)) return;
    const preflight = flags.has("--preflight");
    if (preflight && ["--allow-paid", "--allow-native"].some(flags.has)) return;
    const numbers = {
      tokenBudget: "--token-budget", maxOutputTokens: "--max-output-tokens",
      timeoutSeconds: "--timeout-seconds", repetitions: "--repetitions",
    } as const;
    for (const flag of Object.values(numbers)) {
      const supplied = flags.get(flag);
      if (supplied !== undefined && !/^\d+$/.test(supplied)) return;
    }
    const limits = { ...defaultBenchmarkLimits };
    for (const key of Object.keys(numbers) as (keyof typeof numbers)[]) {
      limits[key] = Number(flags.get(numbers[key]) ?? limits[key]);
    }
    const program = flags.get("--program");
    const evidence = flags.get("--evidence");
    const baselineRef = flags.get("--baseline");
    const caseIds = flags.all("--case");
    const model = flags.get("--model");
    const shared = { repository: process.cwd(), timeoutSeconds: limits.timeoutSeconds, repetitions: limits.repetitions,
      ...(program ? { program: resolve(program) } : {}), ...(evidence ? { evidenceDirectory: resolve(evidence) } : {}),
      ...(baselineRef ? { baselineRef } : {}), ...(caseIds ? { caseIds } : {}), ...(model ? { model } : {}),
    };
    const maxAttempts = flags.get("--max-attempts");
    if (maxAttempts !== undefined && !/^\d+$/.test(maxAttempts)) return;
    const attemptLimit = maxAttempts === undefined ? {} : { maxAttempts: Number(maxAttempts) };
    if (preflight) return { summary: { command: "benchmark", agent, mode, phase: "preflight" }, run: (signal) =>
      runBenchmarkPreflight(agent, { ...shared, ...limits, ...attemptLimit, mode }, signal),
    };
    if (mode === "standard") {
      const authHome = flags.get("--auth-home");
      return { summary: { command: "benchmark", agent, mode }, run: (signal) => runStandardBenchmark(agent, {
        ...shared, ...attemptLimit, allowNative: flags.has("--allow-native"),
        ...(authHome && { authHome: resolve(authHome) }),
      }, signal) };
    }
    return { summary: { command: "benchmark", agent }, run: (signal) => runNativeBenchmark(agent, {
      ...shared, tokenBudget: limits.tokenBudget, maxOutputTokens: limits.maxOutputTokens, allowPaid: flags.has("--allow-paid"),
    }, signal) };
  }
  if (command === "benchmark-review") {
    const flags = options(rest, ["--evidence", "--digest"]);
    const evidence = flags?.get("--evidence");
    const digest = flags?.get("--digest");
    if (!evidence || !digest) return;
    return { summary: { command }, run: () => reviewNativeBenchmark(process.cwd(), resolve(evidence), digest) };
  }
  if (command === "bundle") {
    const flags = options(rest, ["--out", "--version", "--profile"], "--profile");
    const output = flags?.get("--out");
    if (!flags || !output) return;
    const version = flags.get("--version");
    const profiles = flags.all("--profile");
    return { summary: { command }, run: () => runNativeBundle({
      repository: process.cwd(), output: resolve(output), ...(version ? { version } : {}), ...(profiles ? { profiles } : {}),
    }) };
  }
  if (command === "codex") {
    const [action, ...args] = rest;
    const flags = options(args, ["--distribution", "--program", "--home"]);
    if (!flags || (action !== "install" && action !== "update" && action !== "disable" && action !== "uninstall")) return;
    const distribution = flags.get("--distribution");
    const program = flags.get("--program");
    const home = flags.get("--home");
    return { summary: { command, action }, run: () => runCodexLifecycle({
      action, ...(distribution ? { distribution: resolve(distribution) } : {}),
      ...(program ? { program: resolve(program) } : {}), ...(home ? { home: resolve(home) } : {}),
    }) };
  }
}

const operation = parse(process.argv.slice(2));
if (!operation) {
  console.log(JSON.stringify({
    status: "failed",
    reason: "Usage: axiom doctor | check | benchmark <agent> | --benchmark <agent> | benchmark-review | bundle | codex <action>",
  }));
  process.exitCode = 2;
} else {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const { outcome, report } = await operation.run(cancellation.signal);
    console.log(JSON.stringify({ ...operation.summary, ...outcome, ...(report === undefined ? {} : { report }) }));
    process.exitCode = outcome.status === "passed" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
