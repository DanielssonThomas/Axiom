import assert from "node:assert/strict";
import { test } from "node:test";
import { subscriptionLabel } from "./src/notifications.mjs";

test("subscription displays the confirmed label", () => {
  assert.equal(subscriptionLabel(), "Subscribed");
});
