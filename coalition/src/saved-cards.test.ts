/**
 * One copy of each card per customer: every Checkout on a reused `cus_` saves the card again
 * (staging 2026-11-16: one 4242 saved 4× on one customer).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dedupeSavedCards } from "./saved-cards.js";
import type { StripeEvent, StripeLike } from "./stripe.js";

type Card = { id: string; fp: string };
function fake(opts: {
  cards: Card[];
  subs?: { id: string; status: string; pm: string }[];
  custDefault?: string;
  failSubUpdate?: boolean;
  failList?: boolean;
}) {
  const calls = { detached: [] as string[], subUpdates: [] as [string, any][], custUpdates: [] as any[] };
  const stripe = {
    paymentMethods: {
      list: async () => {
        if (opts.failList) throw new Error("permission denied");
        return { data: opts.cards.map((c) => ({ id: c.id, card: { fingerprint: c.fp } })) };
      },
      detach: async (id: string) => void calls.detached.push(id),
    },
    subscriptions: {
      list: async () => ({ data: (opts.subs ?? []).map((s) => ({ id: s.id, status: s.status, default_payment_method: s.pm })) }),
      update: async (id: string, args: any) => {
        if (opts.failSubUpdate) throw new Error("boom");
        calls.subUpdates.push([id, args]);
      },
    },
    customers: {
      retrieve: async () => ({ id: "cus_1", invoice_settings: { default_payment_method: opts.custDefault ?? null } }),
      update: async (_id: string, args: any) => void calls.custUpdates.push(args),
    },
  } as unknown as StripeLike;
  return { stripe, calls };
}

const created = (pm: string | null = "pm_new"): StripeEvent => ({
  id: "evt_1",
  type: "customer.subscription.created",
  data: { object: { id: "sub_new", customer: "cus_1", default_payment_method: pm } },
});

test("removes older copies of the same card, keeps the new one and other cards", async () => {
  const { stripe, calls } = fake({
    cards: [
      { id: "pm_new", fp: "A" },
      { id: "pm_old1", fp: "A" },
      { id: "pm_old2", fp: "A" },
      { id: "pm_other", fp: "B" },
    ],
  });
  await dedupeSavedCards(stripe, created());
  assert.deepEqual(calls.detached.sort(), ["pm_old1", "pm_old2"]);
});

test("a live subscription on a copy moves to the kept card first; a cancelled one is left", async () => {
  const { stripe, calls } = fake({
    cards: [{ id: "pm_new", fp: "A" }, { id: "pm_old", fp: "A" }],
    subs: [
      { id: "sub_live", status: "active", pm: "pm_old" },
      { id: "sub_gone", status: "canceled", pm: "pm_old" },
    ],
    custDefault: "pm_old",
  });
  await dedupeSavedCards(stripe, created());
  assert.deepEqual(calls.subUpdates, [["sub_live", { default_payment_method: "pm_new" }]]);
  assert.deepEqual(calls.custUpdates, [{ invoice_settings: { default_payment_method: "pm_new" } }]);
  assert.deepEqual(calls.detached, ["pm_old"]);
});

test("a copy whose subscription could not be moved stays", async () => {
  const { stripe, calls } = fake({
    cards: [{ id: "pm_new", fp: "A" }, { id: "pm_old", fp: "A" }],
    subs: [{ id: "sub_live", status: "trialing", pm: "pm_old" }],
    failSubUpdate: true,
  });
  await dedupeSavedCards(stripe, created());
  assert.deepEqual(calls.detached, []);
});

test("no card on the subscription, or Stripe refuses: nothing happens, nothing throws", async () => {
  const a = fake({ cards: [{ id: "pm_new", fp: "A" }, { id: "pm_old", fp: "A" }] });
  await dedupeSavedCards(a.stripe, created(null));
  assert.deepEqual(a.calls.detached, []);
  const b = fake({ cards: [], failList: true });
  await dedupeSavedCards(b.stripe, created());
  assert.deepEqual(b.calls.detached, []);
});
