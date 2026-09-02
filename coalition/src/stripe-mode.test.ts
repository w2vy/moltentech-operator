import { test } from "node:test";
import assert from "node:assert/strict";
import { stripeLiveMode } from "./stripe-mode";

test("live and test keys are read off the prefix, restricted keys included", () => {
  assert.equal(stripeLiveMode("sk_live_abc"), true);
  assert.equal(stripeLiveMode("rk_live_abc"), true);
  assert.equal(stripeLiveMode("sk_test_abc"), false);
  // The onboarding transcript hands operators an `rk_test_…` restricted key, so this
  // is the shape a sandbox operator actually runs — not a hypothetical.
  assert.equal(stripeLiveMode("rk_test_abc"), false);
});

// 🔴 The one answer that must never be guessed. A Coalition with no key, or a key shape
// this doesn't know, reports NOTHING — MT then shows no badge. Defaulting to `true`
// here would clear an unreadable listing to look like it takes real money.
test("absent or unrecognised keys report nothing, never live", () => {
  assert.equal(stripeLiveMode(undefined), null);
  assert.equal(stripeLiveMode(""), null);
  assert.equal(stripeLiveMode("pk_live_abc"), null);
  assert.equal(stripeLiveMode("whsec_abc"), null);
});
