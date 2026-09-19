/**
 * Operator #51 — MT's `directive:"cancel"` used to be a dead letter: the Coalition logged
 * "NOT IMPLEMENTED, acked anyway" and the refused, still-trialing subscription lived on to
 * charge the customer for a node that does not exist. It is now cancelled at Stripe before
 * the ack, and a failed cancel is a 502 so Stripe re-delivers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { PaymentRelayResponse } from "@moltentech/protocol";
import { handleWebhook, isBenignRefusal } from "./payments.js";
import type { StripeEvent, StripeLike } from "./stripe.js";

const SUB = "sub_1U7iN1RiVjWePtCvOiH4Zr1P";
const SLUG = "moltentech-test1";

const created: StripeEvent = {
  id: "evt_test_created",
  type: "customer.subscription.created",
  data: {
    object: {
      id: SUB,
      object: "subscription",
      customer: "cus_V7yJ5ZPDzlqexS",
      metadata: { mtCustomerId: "cust_1", providerSlug: SLUG, tier: "cumulus", email: "renter@example.com" },
      items: { data: [{ price: { unit_amount: 700 }, current_period_start: 1787604719, current_period_end: 1790283119 }] },
    },
  },
} as unknown as StripeEvent;

const deleted: StripeEvent = {
  id: "evt_test_deleted",
  type: "customer.subscription.deleted",
  data: { object: { id: SUB, object: "subscription", customer: "cus_V7yJ5ZPDzlqexS", metadata: { providerSlug: SLUG } } },
} as unknown as StripeEvent;

const SIGNING_KEY = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "der" })
  .subarray(-32)
  .toString("base64");
const cfg = { mtBaseUrl: "https://mt.test", providerSlug: SLUG, coalitionSigningKey: SIGNING_KEY, stripeWebhookSecret: "whsec_x" };
const mtSays = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

/** A Stripe fake that records `subscriptions.cancel` calls; `status` is what retrieve reports. */
const fakeStripe = (event: StripeEvent, opts: { status?: string; cancelFails?: boolean } = {}) => {
  const cancelled: string[] = [];
  const stripe = {
    webhooks: { constructEvent: () => event },
    subscriptions: {
      retrieve: async () => ({ customer: "cus_V7yJ5ZPDzlqexS", status: opts.status ?? "trialing" }),
      cancel: async (id: string) => {
        if (opts.cancelFails) throw new Error("stripe down");
        cancelled.push(id);
        return {};
      },
      update: async () => ({}),
    },
  } as unknown as StripeLike;
  return { stripe, cancelled };
};

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
};

const REFUSAL = { ok: true, accepted: false, directive: "cancel", reason: "no_slot_available" };

test("a cancel directive cancels the subscription at Stripe, then acks", async () => {
  const { stripe, cancelled } = fakeStripe(created);
  const status = await quiet(() => handleWebhook(stripe, cfg as any, "{}", "sig", mtSays(200, REFUSAL)));
  assert.equal(status, 200);
  assert.deepEqual(cancelled, [SUB]);
});

test("every refusal reason the hub can direct a cancel for takes the same path", async () => {
  for (const reason of ["no_slot_available", "unknown_customer", "wrong_provider", "no_intent"]) {
    const { stripe, cancelled } = fakeStripe(created);
    const status = await quiet(() => handleWebhook(stripe, cfg as any, "{}", "sig", mtSays(200, { ...REFUSAL, reason })));
    assert.equal(status, 200, reason);
    assert.deepEqual(cancelled, [SUB], reason);
  }
});

test("a failed cancel is NOT acked — 502 so Stripe re-delivers and the cancel is retried", async () => {
  const { stripe, cancelled } = fakeStripe(created, { cancelFails: true });
  const status = await quiet(() => handleWebhook(stripe, cfg as any, "{}", "sig", mtSays(200, REFUSAL)));
  assert.equal(status, 502);
  assert.deepEqual(cancelled, []);
});

test("a re-delivery for a subscription already cancelled acks without a second cancel call", async () => {
  const { stripe, cancelled } = fakeStripe(created, { status: "canceled" });
  const status = await quiet(() => handleWebhook(stripe, cfg as any, "{}", "sig", mtSays(200, REFUSAL)));
  assert.equal(status, 200);
  assert.deepEqual(cancelled, []);
});

test("an accepted relay never cancels", async () => {
  const { stripe, cancelled } = fakeStripe(created);
  const status = await handleWebhook(stripe, cfg as any, "{}", "sig", mtSays(200, { ok: true, accepted: true, rentalCode: "MT-0001" }));
  assert.equal(status, 200);
  assert.deepEqual(cancelled, []);
});

test("the cancel's own subscription.deleted comes back as unknown_subscription and is acked, not looped", async () => {
  const { stripe, cancelled } = fakeStripe(deleted);
  const status = await quiet(() =>
    handleWebhook(stripe, cfg as any, "{}", "sig", mtSays(200, { ok: true, accepted: false, reason: "unknown_subscription" }))
  );
  assert.equal(status, 200);
  assert.deepEqual(cancelled, []);
});

test("unknown_subscription is benign on a cancel or an update but a FAULT on a renewal (MT-0075)", () => {
  assert.equal(isBenignRefusal("subscription.cancelled", "unknown_subscription"), true);
  assert.equal(isBenignRefusal("subscription.updated", "unknown_subscription"), true);
  assert.equal(isBenignRefusal("invoice.payment_succeeded", "unknown_subscription"), false);
  assert.equal(isBenignRefusal("invoice.payment_failed", "unknown_subscription"), false);
  assert.equal(isBenignRefusal("charge.refunded", "no_subscription_ref"), true);
  assert.equal(isBenignRefusal("subscription.created", undefined), false);
});

test("the hub's documented answers all satisfy the shared PaymentRelayResponse schema", () => {
  for (const body of [
    { ok: true, accepted: true, rentalCode: "MT-0001" },
    { ok: true, accepted: true },
    { ok: true, accepted: false, directive: "cancel", reason: "no_slot_available" },
    { ok: true, accepted: false, reason: "unknown_subscription" },
  ]) {
    assert.ok(PaymentRelayResponse.safeParse(body).success, JSON.stringify(body));
  }
  assert.equal(PaymentRelayResponse.safeParse({ ok: true, accepted: false, directive: "refund" }).success, false);
  assert.equal(PaymentRelayResponse.safeParse({ error: "Unauthorized" }).success, false);
});

test("a body outside the schema still falls back to the field-by-field reading", async () => {
  // e.g. a hub release that drops `ok` — the verdict must survive a cosmetic skew.
  const { stripe, cancelled } = fakeStripe(created);
  const status = await quiet(() =>
    handleWebhook(stripe, cfg as any, "{}", "sig", mtSays(200, { accepted: false, directive: "cancel", reason: "no_slot_available" }))
  );
  assert.equal(status, 200);
  assert.deepEqual(cancelled, [SUB]);
});
