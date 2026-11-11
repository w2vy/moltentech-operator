/**
 * Rental checkout shows Stripe's promotion code box, so codes the operator makes in
 * their own Stripe account work on the hub's rentals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleCheckout } from "./payments.js";
import type { StripeLike } from "./stripe.js";

test("checkout session allows promotion codes", async () => {
  const sessions: Record<string, any>[] = [];
  const stripe = {
    prices: { list: async () => ({ data: [{ id: "price_1" }] }) },
    checkout: {
      sessions: {
        create: async (args: Record<string, any>) => {
          sessions.push(args);
          return { url: "https://checkout.stripe.test/s/1" };
        },
      },
    },
  } as unknown as StripeLike;
  const cfg = { providerSlug: "moltentech", tierPrices: { cumulus: 700 }, trialDays: 1 };
  await handleCheckout(stripe, cfg as any, {
    schemaVersion: 1,
    providerSlug: "moltentech",
    tier: "cumulus",
    customer: { mtCustomerId: "cust_1", email: "renter@example.com" },
    idempotencyKey: "k1",
    successUrl: "https://hub.test/ok",
    cancelUrl: "https://hub.test/no",
  } as any);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.allow_promotion_codes, true);
});
