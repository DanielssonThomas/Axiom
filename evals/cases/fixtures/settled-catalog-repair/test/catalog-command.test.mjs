import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/catalog-command.mjs";

test("formats a single catalog word", () => {
  assert.equal(run(" TRAIL "), "trail");
});
