import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseTrialDays } from "./config";

/**
 * TRIAL_DAYS is what reaches Stripe. A 0-day trial charges at checkout for a node that
 * does not exist yet, which the whole checkout design (provision inside the trial,
 * undelivered = nothing charged, Terms A4/B4) assumes cannot happen. tom, 2026-09-15:
 * "The Coalition needs to enforce a minimum of a 1 Day trial."
 */

const BASE = {
  PROVIDER_SLUG: "acme-nodes",
  MT_BASE_URL: "https://fluxhub.moltentech.us",
  COALITION_SIGNING_KEY: "not-a-real-signing-key",
  MT_PUBKEY: "not-a-real-mt-pubkey",
  TIER_PRICES_JSON: "{}",
};

test("unset or empty TRIAL_DAYS is 1", () => {
  assert.equal(parseTrialDays(undefined), 1);
  assert.equal(parseTrialDays(""), 1);
  assert.equal(loadConfig({ ...BASE }).trialDays, 1);
});

test("1 through 30 pass through", () => {
  for (const d of [1, 2, 7, 30]) assert.equal(parseTrialDays(String(d)), d);
  assert.equal(loadConfig({ ...BASE, TRIAL_DAYS: "3" }).trialDays, 3);
});

test("⭐ 0 refuses to start — the floor is load-bearing", () => {
  assert.throws(() => loadConfig({ ...BASE, TRIAL_DAYS: "0" }), /TRIAL_DAYS.*1 to 30.*"0"/s);
});

test("negative, fractional, over the cap and garbage all refuse", () => {
  for (const bad of ["-1", "1.5", "31", "abc", " "]) {
    assert.throws(() => parseTrialDays(bad), /TRIAL_DAYS/, `expected refusal for ${JSON.stringify(bad)}`);
  }
});
