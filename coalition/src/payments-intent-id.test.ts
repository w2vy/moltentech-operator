/**
 * The hub's checkout intent id rides the Stripe subscription (protocol 0.6.22): stamped into the
 * metadata at checkout beside mtCustomerId, echoed back on subscription.created, so the hub binds
 * the sale — and the collateral the customer proved with it — to that exact intent. Absent on
 * either side, nothing changes: no key is written, none is echoed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleCheckout, normalizeEvent } from "./payments.js";
import type { StripeEvent, StripeLike } from "./stripe.js";

const SLUG = "moltentech-test1";
const cfg = { providerSlug: SLUG, tierPrices: { cumulus: 700 }, trialDays: 1 };

function fakeStripe() {
  const sessions: Record<string, any>[] = [];
  const stripe = {
    prices: { search: async () => ({ data: [{ id: "price_1" }] }) },
    checkout: {
      sessions: {
        create: async (args: Record<string, any>) => {
          sessions.push(args);
          return { url: "https://checkout.stripe.test/s/1" };
        },
      },
    },
  } as unknown as StripeLike;
  return { stripe, sessions };
}

const checkoutReq = (customer: Record<string, string>) =>
  ({
    schemaVersion: 1,
    providerSlug: SLUG,
    tier: "cumulus",
    customer: { mtCustomerId: "cust_1", email: "renter@example.com", ...customer },
    idempotencyKey: "k1",
    successUrl: "https://hub.test/ok",
    cancelUrl: "https://hub.test/no",
  }) as any;

test("checkout stamps mtIntentId on the subscription AND the session metadata", async () => {
  const { stripe, sessions } = fakeStripe();
  await handleCheckout(stripe, cfg as any, checkoutReq({ mtIntentId: "intent_1" }));
  assert.equal(sessions[0]!.subscription_data.metadata.mtIntentId, "intent_1");
  assert.equal(sessions[0]!.metadata.mtIntentId, "intent_1");
});

test("an older hub sends no intent → no mtIntentId key is written", async () => {
  const { stripe, sessions } = fakeStripe();
  await handleCheckout(stripe, cfg as any, checkoutReq({}));
  assert.equal("mtIntentId" in sessions[0]!.subscription_data.metadata, false);
});

const created = (metadata: Record<string, string>): StripeEvent =>
  ({
    id: "evt_1",
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        metadata: { mtCustomerId: "cust_1", providerSlug: SLUG, tier: "cumulus", email: "renter@example.com", ...metadata },
        items: { data: [{ price: { unit_amount: 700 }, current_period_start: 1787604719, current_period_end: 1790283119 }] },
      },
    },
  }) as unknown as StripeEvent;

test("subscription.created echoes mtIntentId from the metadata", () => {
  const ev = normalizeEvent(created({ mtIntentId: "intent_1" }), SLUG) as Record<string, unknown>;
  assert.equal(ev.mtIntentId, "intent_1");
});

test("a subscription from before the intent id echoes none", () => {
  const ev = normalizeEvent(created({}), SLUG) as Record<string, unknown>;
  assert.equal("mtIntentId" in ev, false);
});
