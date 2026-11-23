import assert from "node:assert/strict";
import { test } from "node:test";
import { label } from "./label.mjs";

test("trims supplied labels", () => assert.equal(label("  Example  "), "Example"));
