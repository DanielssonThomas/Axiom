import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { defineConfig } from "rolldown";

const zodPackage = createRequire(import.meta.resolve("@axiom/contracts")).resolve("zod/package.json");
const bundledLicenses = [
  ["yaml", import.meta.resolve("yaml/package.json")],
  ["zod", pathToFileURL(zodPackage)],
].map(([name, manifest]) => `${name}\n${readFileSync(new URL("LICENSE", manifest), "utf8").trim()}`);

export default defineConfig({
  input: "dist/hook-entry.js",
  platform: "node",
  output: {
    file: "dist/checker.mjs",
    format: "esm",
    banner: `/*! Bundled dependency licenses\n\n${bundledLicenses.join("\n\n")}\n*/`,
  },
});
