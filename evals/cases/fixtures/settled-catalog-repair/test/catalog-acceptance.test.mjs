import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/catalog-command.mjs";

test("catalog command acceptance", () => {
  assert.equal(run(" Alpine "), "alpine");
});
