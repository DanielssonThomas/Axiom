import { startVitest } from "vitest/node";

// pnpm forwards the separator, but Vitest's CLI ignores filters after it.
const filters = process.argv.slice(process.argv[2] === "--" ? 3 : 2);
await startVitest("test", filters.map((filter) => filter.replaceAll("\\", "/")), { run: true });
