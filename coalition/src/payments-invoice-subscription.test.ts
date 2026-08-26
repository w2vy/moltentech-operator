/**
 * The invoice → subscription id mapping, and the silence around it.
 *
 * MT-0075's 2026-08-24 renewal (`sub_1U7iN1…Zr1P`, $7.00, a real 08-24 → 09-24 cycle) was paid
 * on the operator's Stripe account, relayed by this file, and never reached MT. Nothing failed:
 * `invoice.subscription` no longer exists in the API version the webhook arrives in, so
 * `String(o.subscription)` produced the *string* `"undefined"` — 7 characters, so
 * `z.string().min(1)` accepted it — MT found no such subscription, answered
 * `200 {accepted:false, reason:"unknown_subscription"}`, and the relay's `return res.ok` read
 * that as success and acked Stripe.
 *
 * Two defects, so two sets of tests: the id must be read from where it actually lives, and a
 * refusal must never again be mistaken for an acceptance.
 *
 * The fixtures below are trimmed from the genuine event payload.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, relayPaymentEvent, handleWebhook } from "./payments.js";
import type { StripeEvent, StripeLike } from "./stripe.js";

const SUB = "sub_1U7iN1RiVjWePtCvOiH4Zr1P";
const SLUG = "moltentech-test1";

/** The 2026 shape: no root `subscription`, id under `parent.subscription_details`. */
const renewal = (over: Record<string, any> = {}): StripeEvent =>
  ({
    id: "evt_test_renewal",
    type: "invoice.payment_succeeded",
    data: {
      object: {
        id: "in_1U84rDRiVjWePtCvtPZ2Bqko",
        object: "invoice",
        amount_paid: 700,
        billing_reason: "subscription_cycle",
        customer: "cus_V7yJ5ZPDzlqexS",
        // The PREVIOUS cycle. Reading these instead of the line item is its own bug.
        period_start: 1787518319,
        period_end: 1787604719,
        parent: { type: "subscription_details", subscription_details: { subscription: SUB } },
        lines: {
          data: [
            {
              period: { start: 1787604719, end: 1790283119 },
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { subscription: SUB },
              },
            },
          ],
        },
        ...over,
      },
    },
  }) as unknown as StripeEvent;

test("the renewal's subscription id is read from parent.subscription_details", () => {
  const ev = normalizeEvent(renewal(), SLUG) as any;
  assert.equal(ev.type, "invoice.payment_succeeded");
  assert.equal(ev.stripeSubscriptionId, SUB);
});

test("the line item's parent is a fallback when the invoice has no parent", () => {
  const ev = normalizeEvent(renewal({ parent: null }), SLUG) as any;
  assert.equal(ev.stripeSubscriptionId, SUB);
});

test("an older API version's root field still wins", () => {
  const ev = normalizeEvent(renewal({ subscription: SUB, parent: null, lines: { data: [{ period: { start: 1, end: 2 } }] } }), SLUG) as any;
  assert.equal(ev.stripeSubscriptionId, SUB);
});

test("the literal string 'undefined' can never be produced again", () => {
  // The regression itself: every field is absent, so the id must be undefined — NOT stringified.
  const ev = normalizeEvent(renewal({ parent: null, lines: { data: [{ period: { start: 1, end: 2 } }] } }), SLUG) as any;
  assert.equal(ev.stripeSubscriptionId, undefined);
  assert.notEqual(ev.stripeSubscriptionId, "undefined");
});

test("the period comes from the line item, not the invoice root", () => {
  // The root pair is the cycle that just ENDED; relaying it would move MT's clock backwards.
  const ev = normalizeEvent(renewal(), SLUG) as any;
  assert.equal(ev.currentPeriodStart, new Date(1787604719 * 1000).toISOString());
  assert.equal(ev.currentPeriodEnd, new Date(1790283119 * 1000).toISOString());
});

test("a failed payment reads the same relocated field", () => {
  const ev = normalizeEvent(
    { ...renewal(), type: "invoice.payment_failed" } as StripeEvent,
    SLUG
  ) as any;
  assert.equal(ev.stripeSubscriptionId, SUB);
});

// ── the silence ────────────────────────────────────────────────────────────────

const cfg = { mtBaseUrl: "https://mt.test", agentKey: "k" };
const mtSays = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

test("a refusal is NOT reported as an acceptance", async () => {
  const r = await relayPaymentEvent(
    cfg,
    normalizeEvent(renewal(), SLUG)!,
    mtSays(200, { ok: true, accepted: false, reason: "unknown_subscription" })
  );
  assert.equal(r.delivered, true);
  assert.equal(r.accepted, false, "this is the bug: a 200 with accepted:false read as success");
  assert.equal(r.reason, "unknown_subscription");
});

const webhook = (status: number, body: unknown, event = renewal()) => {
  const stripe = { webhooks: { constructEvent: () => event } } as unknown as StripeLike;
  return handleWebhook(
    stripe,
    { providerSlug: SLUG, stripeWebhookSecret: "whsec_x", ...cfg } as any,
    "{}",
    "sig",
    mtSays(status, body)
  );
};

test("MT refusing an event means Stripe is NOT acked", async () => {
  assert.equal(await webhook(200, { ok: true, accepted: false, reason: "unknown_subscription" }), 502);
});

test("an accepted event acks", async () => {
  assert.equal(await webhook(200, { ok: true, accepted: true }), 200);
});

test("the one benign refusal still acks", async () => {
  // MT's own comment on `no_subscription_ref`: "record nothing but ack so it isn't retried".
  assert.equal(await webhook(200, { ok: true, accepted: false, reason: "no_subscription_ref" }), 200);
});

test("an unmappable event is not quietly acked", async () => {
  // No subscription id anywhere → the mapping fails its own schema. This used to return 200.
  const blind = renewal({ parent: null, lines: { data: [{ period: { start: 1, end: 2 } }] } });
  assert.equal(await webhook(200, { ok: true, accepted: true }, blind), 502);
});
