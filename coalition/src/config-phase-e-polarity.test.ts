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
  assert.equal(cfg.agentKey, undefined);
  assert.equal(cfg.coalitionKey, undefined);
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

test("the legacy bearers still load when present (the rollback path survives)", () => {
  const cfg = loadConfig({ ...BASE, AGENT_KEY: "ak", COALITION_KEY: "ck" });
  assert.equal(cfg.agentKey, "ak");
  assert.equal(cfg.coalitionKey, "ck");
});
