/**
 * The hub answers `subscription.created` with the rental code it just minted; the Coalition
 * used to read `res.ok` and drop it. From the operator's own Stripe dashboard that left two
 * same-tier subscriptions from one customer indistinguishable. The code is now stamped onto
 * the subscription's metadata — after the relay is accepted, never fatally, and not twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { handleWebhook } from "./payments.js";
import type { StripeEvent, StripeLike } from "./stripe.js";

const SUB = "sub_1U7iN1RiVjWePtCvOiH4Zr1P";
const SLUG = "moltentech-test1";
const CODE = "MT-0062";

const created = (metadata: Record<string, string> = {}): StripeEvent =>
  ({
    id: "evt_test_created",
    type: "customer.subscription.created",
    data: {
      object: {
        id: SUB,
        object: "subscription",
        customer: "cus_V7yJ5ZPDzlqexS",
        metadata: { mtCustomerId: "cust_1", providerSlug: SLUG, tier: "cumulus", email: "renter@example.com", ...metadata },
        items: { data: [{ price: { unit_amount: 700 }, current_period_start: 1787604719, current_period_end: 1790283119 }] },
      },
    },
  }) as unknown as StripeEvent;

const SIGNING_KEY = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "der" })
  .subarray(-32)
  .toString("base64");
const cfg = { mtBaseUrl: "https://mt.test", providerSlug: SLUG, coalitionSigningKey: SIGNING_KEY, stripeWebhookSecret: "whsec_x" };
const mtSays = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

/** A Stripe fake that records `subscriptions.update` calls and can be made to fail. */
const fakeStripe = (event: StripeEvent, fail = false) => {
  const updates: [string, Record<string, unknown>][] = [];
  const stripe = {
    webhooks: { constructEvent: () => event },
    subscriptions: {
      update: async (id: string, args: Record<string, unknown>) => {
        if (fail) throw new Error("stripe down");
        updates.push([id, args]);
        return {};
      },
    },
  } as unknown as StripeLike;
  return { stripe, updates };
};

test("an accepted subscription.created stamps rentalCode onto the subscription", async () => {
  const { stripe, updates } = fakeStripe(created());
  const status = await handleWebhook(stripe, cfg as any, "{}", "sig", mtSays(200, { ok: true, accepted: true, rentalCode: CODE }));
  assert.equal(status, 200);
  assert.deepEqual(updates, [[SUB, { metadata: { rentalCode: CODE } }]]);
});

test("a re-delivery whose subscription already carries the code does not call Stripe", async () => {
  const { stripe, updates } = fakeStripe(created({ rentalCode: CODE }));
  assert.equal(await handleWebhook(stripe, cfg as any, "{}", "sig", mtSays(200, { ok: true, accepted: true, rentalCode: CODE })), 200);
  assert.deepEqual(updates, []);
});

test("a Stripe failure while stamping is logged, not turned into a 502", async () => {
  const { stripe } = fakeStripe(created(), true);
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    assert.equal(await handleWebhook(stripe, cfg as any, "{}", "sig", mtSays(200, { ok: true, accepted: true, rentalCode: CODE })), 200);
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1);
});

test("a hub answer without a rentalCode stamps nothing", async () => {
  const { stripe, updates } = fakeStripe(created());
  assert.equal(await handleWebhook(stripe, cfg as any, "{}", "sig", mtSays(200, { ok: true, accepted: true })), 200);
  assert.deepEqual(updates, []);
});
