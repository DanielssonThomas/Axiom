#!/usr/bin/env node

import { evidenceOutcomeSchema } from "@axiom/contracts";

type Command = { command: "doctor" | "check" } | { command: "benchmark"; agent: string };

function parseCommand(args: readonly string[]): Command | undefined {
  const [command, agent] = args;
  if (args.length === 1 && (command === "doctor" || command === "check")) {
    return { command };
  }

  if (
    args.length === 2
    && (command === "benchmark" || command === "--benchmark")
    && agent
    && !/^-|\s/.test(agent)
  ) {
    return { command: "benchmark", agent };
  }
}

const command = parseCommand(process.argv.slice(2));
const outcome = command
  ? evidenceOutcomeSchema.parse({ status: "not_run", reason: `${command.command} is not implemented.` })
  : evidenceOutcomeSchema.parse({
    status: "failed",
    reason: "Usage: axiom doctor | check | benchmark <agent> | --benchmark <agent>",
  });

console.log(JSON.stringify({ ...command, ...outcome }));
process.exitCode = command ? 1 : 2;
