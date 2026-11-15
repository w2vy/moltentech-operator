/**
 * `/add-item` (customer_subscription_plan.md phase 3a): one more node on the customer's bill.
 * Checks first, charges second, lets MT mint the rental third; a refusal after the charge
 * removes the node and reports what to refund (D12).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleAddItem, cardRefusal } from "./add-item.js";
import { normalizeEvent } from "./payments.js";
import type { StripeEvent, StripeLike } from "./stripe.js";

const SLUG = "moltentech-test1";
const cfg = { providerSlug: SLUG, tierPrices: { cumulus: 700 }, trialDays: 1, mtBaseUrl: "https://mt.test" };
const req = (over: Record<string, unknown> = {}) =>
  ({
    schemaVersion: 1,
    providerSlug: SLUG,
    tier: "cumulus",
    stripeSubscriptionId: "sub_1",
    customer: { mtCustomerId: "cust_1", email: "renter@example.com", mtIntentId: "int_2", stripeCustomerId: "cus_1" },
    idempotencyKey: "k1",
    ...over,
  }) as any;

function fake(opts: { sub?: Record<string, unknown>; items?: number; createError?: unknown } = {}) {
  const calls = { created: [] as Record<string, any>[], deleted: [] as string[], updated: [] as [string, any][] };
  const sub = { id: "sub_1", customer: "cus_1", status: "active", metadata: { mtCustomerId: "cust_1" }, current_period_start: 1000, current_period_end: 2000, ...opts.sub };
  const stripe = {
    prices: { list: async () => ({ data: [{ id: "price_1", product: "prod_1" }] }) },
    subscriptions: {
      retrieve: async (_id: string, args?: Record<string, unknown>) =>
        args?.expand ? { ...sub, latest_invoice: { amount_paid: 350 } } : sub,
    },
    subscriptionItems: {
      list: async () => ({ data: Array.from({ length: opts.items ?? 1 }, (_, i) => ({ id: `si_${i}` })) }),
      create: async (args: Record<string, any>) => {
        if (opts.createError) throw opts.createError;
        calls.created.push(args);
        return { id: "si_new" };
      },
      del: async (id: string) => void calls.deleted.push(id),
      update: async (id: string, args: unknown) => void calls.updated.push([id, args]),
    },
  } as unknown as StripeLike;
  return { stripe, calls };
}
const accepts = async (_c: unknown, ev: any) => ({ delivered: true, accepted: true, rentalCode: "MT-0200", _ev: ev });

test("an eligible bill: node added at its price, rest of period charged, MT mints the rental", async () => {
  const { stripe, calls } = fake();
  const relayed: any[] = [];
  const res = await handleAddItem(stripe, cfg as any, req(), async (_c, ev) => {
    relayed.push(ev);
    return { delivered: true, accepted: true, rentalCode: "MT-0200" };
  });
  assert.equal(res.added, true);
  assert.equal(res.rentalCode, "MT-0200");
  assert.equal(res.stripeSubscriptionItemId, "si_new");
  assert.equal(res.chargedCents, 350);
  assert.equal(res.priceCents, 700);
  const c = calls.created[0]!;
  assert.equal(c.subscription, "sub_1");
  assert.equal(c.price_data.unit_amount, 700);
  assert.equal(c.price_data.product, "prod_1", "price_data on the tier product — one price object can't sit on two items");
  assert.equal(c.proration_behavior, "always_invoice");
  assert.equal(c.payment_behavior, "error_if_incomplete");
  assert.equal(c.metadata.mtIntentId, "int_2");
  assert.equal(relayed[0].type, "subscription.item_added");
  assert.equal(relayed[0].stripeSubscriptionItemId, "si_new");
  assert.equal(relayed[0].mtIntentId, "int_2");
  assert.equal(relayed[0].amountPaidCents, 350);
  assert.deepEqual(calls.updated, [["si_new", { metadata: { rentalCode: "MT-0200" } }]]);
});

for (const [name, opts, r] of [
  ["another Stripe customer's bill", { sub: { customer: "cus_OTHER" } }, req()],
  ["a bill opened for another hub customer", { sub: { metadata: { mtCustomerId: "cust_OTHER" } } }, req()],
  ["a trialing bill", { sub: { status: "trialing" } }, req()],
  ["a past-due bill", { sub: { status: "past_due" } }, req()],
  ["a bill with a bill-wide discount", { sub: { discounts: ["di_1"] } }, req()],
  ["a full bill (100 nodes)", { items: 100 }, req()],
] as const) {
  test(`not eligible: ${name} — nothing created, nothing relayed`, async () => {
    const { stripe, calls } = fake(opts as any);
    let relayed = 0;
    const res = await handleAddItem(stripe, cfg as any, r, async () => {
      relayed++;
      return { delivered: true, accepted: true };
    });
    assert.equal(res.added, false);
    assert.equal(res.reason, "not_eligible");
    assert.equal(calls.created.length, 0);
    assert.equal(relayed, 0);
  });
}

test("a declined card: card_failed, nothing relayed", async () => {
  const { stripe } = fake({ createError: Object.assign(new Error("Your card was declined."), { type: "StripeCardError", code: "card_declined" }) });
  const res = await handleAddItem(stripe, cfg as any, req(), accepts as any);
  assert.equal(res.added, false);
  assert.equal(res.reason, "card_failed");
});

test("3-D Secure needed: action_required", () => {
  assert.equal(cardRefusal({ code: "subscription_payment_intent_requires_action" }), "action_required");
  assert.equal(cardRefusal({ raw: { type: "card_error", code: "card_declined" } }), "card_failed");
  assert.equal(cardRefusal(new Error("rate limited")), null);
});

test("D12: charged but MT refuses → the node comes off the bill and the refund amount is reported", async () => {
  const { stripe, calls } = fake();
  const err = console.error;
  console.error = () => {};
  try {
    const res = await handleAddItem(stripe, cfg as any, req(), async () => ({ delivered: true, accepted: false, directive: "cancel", reason: "no_slot_available" }));
    assert.equal(res.added, false);
    assert.equal(res.reason, "refused");
    assert.equal(res.chargedCents, 350);
    assert.deepEqual(calls.deleted, ["si_new"]);
  } finally {
    console.error = err;
  }
});

test("MT unreachable is retried before giving up", async () => {
  const { stripe, calls } = fake();
  let tries = 0;
  const res = await handleAddItem(stripe, cfg as any, req(), async () => {
    tries++;
    return tries < 3 ? { delivered: false, accepted: false } : { delivered: true, accepted: true, rentalCode: "MT-0201" };
  });
  assert.equal(tries, 3);
  assert.equal(res.added, true);
  assert.deepEqual(calls.deleted, []);
});

test("a coupon prices the added node like a coupon checkout", async () => {
  const { stripe, calls } = fake();
  // An unverifiable coupon is refused outright (the hub never sends one it didn't get signed).
  await assert.rejects(handleAddItem(stripe, cfg as any, req({ coupon: { claim: {}, signature: "x" } }), accepts as any), /coupon refused/);
  assert.equal(calls.created.length, 0);
});

const invoice = (billing_reason: string, lines: unknown[]): StripeEvent =>
  ({ id: "evt_i", type: "invoice.payment_succeeded", data: { object: { billing_reason, amount_paid: 350, parent: { subscription_details: { subscription: "sub_1" } }, lines: { data: lines } } } }) as unknown as StripeEvent;

test("G4: the add-item invoice (prorations only) is not relayed as a renewal", () => {
  const ev = normalizeEvent(invoice("subscription_update", [{ amount: 350, period: { start: 1, end: 2 }, parent: { subscription_item_details: { subscription_item: "si_new", proration: true } } }]), SLUG);
  assert.equal(ev, null);
});

test("G4: an ended trial (subscription_update with a normal line) still relays", () => {
  const ev = normalizeEvent(invoice("subscription_update", [{ amount: 700, period: { start: 1, end: 2 }, parent: { subscription_item_details: { subscription_item: "si_1", proration: false } } }]), SLUG);
  assert.equal((ev as any)?.type, "invoice.payment_succeeded");
});
