import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config";

// ⭐ Phase E polarity flip (2026-09-07). Before this, `COALITION_KEY`/`AGENT_KEY` were
// `req()`d and `COALITION_SIGNING_KEY`/`MT_PUBKEY` were optional — so a Coalition
// redeployed from a stale `env.json` booted CLEANLY and silently fell back to bearer.
// That is the exact regression the Phase D soak watches for, and the config was shaped
// to produce it. These tests pin the polarity, not the mechanism.

const BASE = {
  PROVIDER_SLUG: "pve25-lab",
  MT_BASE_URL: "https://mt.example",
  COALITION_SIGNING_KEY: "not-a-real-signing-key",
  MT_PUBKEY: "not-a-real-mt-pubkey",
  TIER_PRICES_JSON: "{}",
} as NodeJS.ProcessEnv;

test("⭐ boots with NEITHER legacy bearer set", () => {
  const cfg = loadConfig({ ...BASE });
  assert.deepEqual(cfg.legacyBearersPresent, []);
  assert.equal(cfg.coalitionSigningKey, "not-a-real-signing-key");
});

test("⭐ REFUSES to boot without COALITION_SIGNING_KEY — a stale env.json now fails loudly", () => {
  const env = { ...BASE };
  delete env.COALITION_SIGNING_KEY;
  assert.throws(() => loadConfig(env), /COALITION_SIGNING_KEY/);
});

test("⭐ REFUSES to boot without MT_PUBKEY — an unpinned Coalition is bearer-only inbound", () => {
  const env = { ...BASE };
  delete env.MT_PUBKEY;
  assert.throws(() => loadConfig(env), /MT_PUBKEY/);
});

// Phase E step 4 (2026-09-07): the bearers are gone from every code path. What survives
// is a NOTICE — an operator whose env.json still carries them is told once, at startup,
// that the lines are dead. Nothing else in the config knows they exist.
test("🔒 legacy bearers are NOT loaded as credentials, only NAMED as dead weight", () => {
  const cfg = loadConfig({ ...BASE, AGENT_KEY: "ak", COALITION_KEY: "ck" });
  assert.deepEqual(cfg.legacyBearersPresent, ["AGENT_KEY", "COALITION_KEY"]);
  // The VALUES must not survive anywhere on the config — a credential the code cannot
  // use is one nobody audits, and it would still be sitting in a heap dump.
  assert.equal(JSON.stringify(cfg).includes("ak"), false);
  assert.equal(JSON.stringify(cfg).includes("ck"), false);
});

test("only the bearer actually present is named", () => {
  assert.deepEqual(loadConfig({ ...BASE, AGENT_KEY: "ak" }).legacyBearersPresent, ["AGENT_KEY"]);
  assert.deepEqual(loadConfig({ ...BASE, COALITION_KEY: "ck" }).legacyBearersPresent, ["COALITION_KEY"]);
});
