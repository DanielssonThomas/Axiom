import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "./src/summary.mjs";

test("returns one label per line", () => {
  assert.equal(summarize(["blue", "green"]), "blue\ngreen");
});
