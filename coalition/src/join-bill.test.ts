/**
 * `/join-bill` (customer_subscription_plan.md phase 4, tom 11-17): a node alone on its own bill
 * joins another of the customer's bills just before its old bill renews. The line moves at its
 * current price, charged only from the old renewal on; the old bill closes with no credit and its
 * cancel is not relayed (the rental did not end).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleJoinBill } from "./join-bill.js";
import { normalizeEvent, itemsChangedEvent, MOVED_TO, JOINED_FROM } from "./payments.js";
import type { StripeEvent, StripeLike } from "./stripe.js";

const SLUG = "moltentech-test1";
const cfg = { providerSlug: SLUG, tierPrices: { cumulus: 700 }, trialDays: 1, mtBaseUrl: "https://mt.test" } as any;
const req = (over: Record<string, unknown> = {}) =>
  ({
    schemaVersion: 1,
    providerSlug: SLUG,
    rentalCode: "MT-0197",
    fromSubscriptionId: "sub_old",
    toSubscriptionId: "sub_main",
    customer: { mtCustomerId: "cust_1", stripeCustomerId: "cus_1" },
    ...over,
  }) as any;

const RENEWAL = 1_800_000_000;

function fake(opts: {
  from?: Record<string, unknown>;
  to?: Record<string, unknown>;
  fromItems?: Record<string, any>[];
  toItems?: Record<string, any>[];
  createError?: unknown;
  cancelError?: unknown;
  invoices?: Record<string, any>[];
} = {}) {
  const calls = { created: [] as [Record<string, any>, any][], updated: [] as [string, any][], cancelled: [] as [string, any][] };
  const subs: Record<string, Record<string, any>> = {
    sub_old: { id: "sub_old", customer: "cus_1", status: "active", metadata: { mtCustomerId: "cust_1", rentalCode: "MT-0197", tier: "stratus" }, ...opts.from },
    sub_main: { id: "sub_main", customer: "cus_1", status: "active", metadata: { mtCustomerId: "cust_1" }, current_period_end: RENEWAL + 86400 * 9, ...opts.to },
  };
  const items: Record<string, Record<string, any>[]> = {
    sub_old: opts.fromItems ?? [{ id: "si_old", price: { unit_amount: 1400, product: "prod_stratus" }, metadata: { rentalCode: "MT-0197", tier: "stratus" }, current_period_end: RENEWAL }],
    sub_main: opts.toItems ?? [{ id: "si_a", price: { unit_amount: 700 }, metadata: { rentalCode: "MT-0190" } }],
  };
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => subs[id],
      update: async (id: string, args: unknown) => void calls.updated.push([id, args]),
      cancel: async (id: string, args: unknown) => {
        if (opts.cancelError) throw opts.cancelError;
        calls.cancelled.push([id, args]);
      },
    },
    subscriptionItems: {
      list: async (a: { subscription: string }) => ({ data: items[a.subscription] ?? [] }),
      create: async (args: Record<string, any>, o: any) => {
        if (opts.createError) throw opts.createError;
        calls.created.push([args, o]);
        return { id: "si_new" };
      },
      retrieve: async (id: string) => ({ id, current_period_end: RENEWAL + 86400 * 9 }),
    },
    invoices: {
      // The target's invoices, newest first: a later renewal, then the move's proration.
      list: async (a: { subscription: string }) => ({
        data:
          a.subscription !== "sub_main"
            ? []
            : (opts.invoices ?? [
                { id: "in_cycle", amount_paid: 2100, lines: { data: [{ subscription_item: "si_a", proration: false }] } },
                { id: "in_move", amount_paid: 420, lines: { data: [{ subscription_item: "si_new", proration: true }] } },
              ]),
      }),
    },
  } as unknown as StripeLike;
  return { stripe, calls };
}

test("joins: line copied at its price, charged from the old renewal, old bill stamped then cancelled with no credit", async () => {
  const { stripe, calls } = fake();
  const res = await handleJoinBill(stripe, cfg, req());
  assert.equal(res.joined, true);
  assert.equal(res.stripeSubscriptionItemId, "si_new");
  assert.equal(res.chargedCents, 420);
  assert.equal(res.priceCents, 1400);
  assert.equal(res.oldBillCancelled, true);
  assert.equal(res.currentPeriodEnd, new Date((RENEWAL + 86400 * 9) * 1000).toISOString());
  const [c, o] = calls.created[0]!;
  assert.equal(c.subscription, "sub_main");
  assert.equal(c.price_data.unit_amount, 1400, "the node's price today, not the tier list price");
  assert.equal(c.price_data.product, "prod_stratus");
  assert.equal(c.proration_date, RENEWAL, "charged only from the old bill's renewal");
  assert.equal(c.proration_behavior, "always_invoice");
  assert.equal(c.payment_behavior, "error_if_incomplete");
  assert.equal(c.metadata.rentalCode, "MT-0197");
  assert.equal(c.metadata.tier, "stratus");
  assert.equal(c.metadata[JOINED_FROM], "sub_old");
  assert.equal(c.metadata.mtIntentId, undefined);
  assert.match(o.idempotencyKey, /MT-0197/);
  assert.deepEqual(calls.updated[0], ["sub_old", { metadata: { [MOVED_TO]: "sub_main" } }], "stamped before the cancel");
  assert.deepEqual(calls.cancelled[0], ["sub_old", { prorate: false, invoice_now: false }]);
});

test("a new try after a declined card uses the hub's new key (Stripe replays a seen key's answer for 24 h)", async () => {
  const keys: string[] = [];
  for (const k of ["pay_1:1000", "pay_1:2000"]) {
    const { stripe, calls } = fake();
    await handleJoinBill(stripe, cfg, req({ idempotencyKey: k }));
    keys.push(calls.created[0]![1].idempotencyKey);
  }
  assert.deepEqual(keys, ["join-bill:pay_1:1000", "join-bill:pay_1:2000"]);
});

test("a coupon price carries over with its coupon facts", async () => {
  const { stripe, calls } = fake({
    fromItems: [{ id: "si_old", price: { unit_amount: 350, product: "prod_c" }, metadata: { rentalCode: "MT-0197", tier: "cumulus", mtCoupon: "HALF", mtCouponPct: "50" }, current_period_end: RENEWAL }],
  });
  const res = await handleJoinBill(stripe, cfg, req());
  assert.equal(res.joined, true);
  const c = calls.created[0]![0];
  assert.equal(c.price_data.unit_amount, 350);
  assert.equal(c.metadata.mtCoupon, "HALF");
});

test("a trialing old bill can join (its trial end is the renewal)", async () => {
  const { stripe } = fake({ from: { status: "trialing" } });
  assert.equal((await handleJoinBill(stripe, cfg, req())).joined, true);
});

for (const [name, opts, r] of [
  ["old bill is another customer's", { from: { customer: "cus_2" } }, undefined],
  ["target is another customer's", { to: { metadata: { mtCustomerId: "cust_9" } } }, undefined],
  ["target not active", { to: { status: "past_due" } }, undefined],
  ["target trialing", { to: { status: "trialing" } }, undefined],
  ["target has a bill-wide discount", { to: { discounts: ["di_1"] } }, undefined],
  ["target full", { toItems: Array.from({ length: 100 }, (_, i) => ({ id: `si_${i}`, metadata: {} })) }, undefined],
  ["old bill cancelling", { from: { cancel_at_period_end: true } }, undefined],
  ["old bill past due", { from: { status: "past_due" } }, undefined],
  ["old bill has two nodes", { fromItems: [{ id: "si_1", metadata: {} }, { id: "si_2", metadata: {} }] }, undefined],
  ["old bill is another rental's", {}, { rentalCode: "MT-0001" }],
  ["same bill both sides", {}, { toSubscriptionId: "sub_old" }],
] as const) {
  test(`not eligible: ${name} — nothing changed`, async () => {
    const { stripe, calls } = fake(opts as any);
    const res = await handleJoinBill(stripe, cfg, req(r ?? {}));
    assert.equal(res.joined, false);
    assert.equal(res.reason, "not_eligible");
    assert.equal(calls.created.length, 0);
    assert.equal(calls.cancelled.length, 0);
  });
}

test("declined card / 3-D Secure: nothing changed, the old bill renews as normal", async () => {
  for (const [err, reason] of [
    [{ type: "StripeCardError", code: "card_declined" }, "card_failed"],
    [{ code: "subscription_payment_intent_requires_action" }, "action_required"],
  ] as const) {
    const { stripe, calls } = fake({ createError: err });
    const res = await handleJoinBill(stripe, cfg, req());
    assert.equal(res.joined, false);
    assert.equal(res.reason, reason);
    assert.equal(calls.cancelled.length, 0);
    assert.equal(calls.updated.length, 0);
  }
});

test("retry after a lost answer: the line is already on the target → no second charge, cancel finished", async () => {
  const { stripe, calls } = fake({
    toItems: [{ id: "si_a", metadata: {} }, { id: "si_new", price: { unit_amount: 1400 }, metadata: { rentalCode: "MT-0197" } }],
  });
  const res = await handleJoinBill(stripe, cfg, req());
  assert.equal(res.joined, true);
  assert.equal(res.stripeSubscriptionItemId, "si_new");
  // prod 2026-11-17 (MT-0198): the first try added the line, then failed; the retry must still
  // report what that try charged, not 0.
  assert.equal(res.chargedCents, 420);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.cancelled.length, 1);
});

test("retry when the old bill is already closed: joined, nothing more done", async () => {
  const { stripe, calls } = fake({
    from: { status: "canceled" },
    toItems: [{ id: "si_new", price: { unit_amount: 1400 }, metadata: { rentalCode: "MT-0197" } }],
  });
  const res = await handleJoinBill(stripe, cfg, req());
  assert.equal(res.joined, true);
  assert.equal(res.oldBillCancelled, true);
  assert.equal(calls.cancelled.length, 0);
});

test("line added but the old bill won't cancel: joined, oldBillCancelled false (hub alerts the operator)", async () => {
  const { stripe } = fake({ cancelError: new Error("rate limited") });
  const res = await handleJoinBill(stripe, cfg, req());
  assert.equal(res.joined, true);
  assert.equal(res.oldBillCancelled, false);
});

const ev = (type: string, object: Record<string, unknown>, prev?: Record<string, unknown>) =>
  ({ id: "evt_1", type, data: { object, ...(prev ? { previous_attributes: prev } : {}) } }) as unknown as StripeEvent;

test("the moved bill's cancel is NOT relayed; a plain cancel still is", () => {
  assert.equal(normalizeEvent(ev("customer.subscription.deleted", { id: "sub_old", metadata: { [MOVED_TO]: "sub_main" } }), SLUG), null);
  assert.equal(normalizeEvent(ev("customer.subscription.deleted", { id: "sub_x", metadata: {} }), SLUG)?.type, "subscription.cancelled");
});

test("the moved line is not reported as a line added by hand", () => {
  const moved = ev(
    "customer.subscription.updated",
    { id: "sub_main", items: { data: [{ id: "si_a" }, { id: "si_new", metadata: { [JOINED_FROM]: "sub_old" } }] } },
    { items: { data: [{ id: "si_a" }] } }
  );
  assert.equal(itemsChangedEvent(moved, SLUG), null);
});

test("the charge is read by the node's own line, whichever Stripe API shape the line has", async () => {
  const { stripe } = fake({
    invoices: [
      { id: "in_other", amount_paid: 999, lines: { data: [{ parent: { subscription_item_details: { subscription_item: "si_x", proration: true } } }] } },
      { id: "in_move", amount_paid: 445, lines: { data: [{ parent: { subscription_item_details: { subscription_item: "si_new", proration: true } } }] } },
    ],
  });
  assert.equal((await handleJoinBill(stripe, cfg, req())).chargedCents, 445);
});

test("no proration invoice for the line (nothing charged): 0", async () => {
  const { stripe } = fake({ invoices: [] });
  assert.equal((await handleJoinBill(stripe, cfg, req())).chargedCents, 0);
});
