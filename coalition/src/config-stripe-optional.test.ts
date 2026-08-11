import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config";

/**
 * NO_STRIPE: a self-hoster running their own nodes on Foundation collateral has no
 * customers and should never have needed a Stripe account. Both keys used to be read
 * through `req()`, which throws — so the Coalition would not start at all. The gate is
 * now the PRICE LIST, not the presence of the keys.
 */

const BASE = {
  PROVIDER_SLUG: "acme-nodes",
  MT_BASE_URL: "https://www.moltentech.us",
  AGENT_KEY: "agent-key",
  COALITION_KEY: "coalition-key",
};

test("selling nothing loads with no Stripe keys at all", () => {
  // ⚠️ "Free" is an EMPTY price list, not a tier priced at 0: MT enforces a per-tier
  // floor (700 cents at the lowest) and 422s anything below it, so a 0-priced listing
  // cannot exist. The self-hoster rents to themselves via the hub free-rental path.
  const cfg = loadConfig({ ...BASE, TIER_PRICES_JSON: "{}" });
  assert.equal(cfg.stripeSecretKey, undefined);
  assert.equal(cfg.stripeWebhookSecret, undefined);
  assert.deepEqual(cfg.tierPrices, {});
});

test("a tier priced at 0 is still rejected by the schema — the floor makes it unlistable", () => {
  assert.throws(() => loadConfig({ ...BASE, TIER_PRICES_JSON: JSON.stringify({ cumulus: 0 }) }));
});

test("a PAID listing with no Stripe keys refuses, and names the tier", () => {
  assert.throws(
    () => loadConfig({ ...BASE, TIER_PRICES_JSON: JSON.stringify({ cumulus: 700 }) }),
    /STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.*cumulus/s
  );
});

test("a paid listing missing only the webhook secret names just that one", () => {
  assert.throws(
    () =>
      loadConfig({
        ...BASE,
        TIER_PRICES_JSON: JSON.stringify({ nimbus: 2000 }),
        STRIPE_SECRET_KEY: "sk_test_x",
      }),
    /Missing required env STRIPE_WEBHOOK_SECRET/
  );
});

test("a paid listing with both keys loads", () => {
  const cfg = loadConfig({
    ...BASE,
    TIER_PRICES_JSON: JSON.stringify({ cumulus: 700 }),
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
  });
  assert.equal(cfg.stripeSecretKey, "sk_test_x");
});

test("any listed tier at all requires Stripe", () => {
  assert.throws(
    () => loadConfig({ ...BASE, TIER_PRICES_JSON: JSON.stringify({ cumulus: 700, nimbus: 2000 }) }),
    /cumulus, nimbus/
  );
});

test("the error explains how to run without Stripe", () => {
  // A message that only says "missing env" sends the reader to Stripe to make an
  // account they may not need.
  assert.throws(() => loadConfig({ ...BASE, TIER_PRICES_JSON: JSON.stringify({ cumulus: 700 }) }), /TIER_PRICES_JSON=\{\}/);
});

test("the other required env vars are still required", () => {
  assert.throws(() => loadConfig({ TIER_PRICES_JSON: "{}" }), /Missing required env PROVIDER_SLUG/);
});
