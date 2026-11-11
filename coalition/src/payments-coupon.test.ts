/**
 * Operator coupons on card (hub plan `operator_coupons_plan.md`, phase 3): the Coalition
 * discounts only a coupon its OWN owner wallet signed, and maps it onto Stripe the way the
 * 2026-11-11 test-clock run proved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { addCalendarMonths, couponMessage, type CouponClaim, type SignedCoupon } from "@moltentech/protocol";
import { signFluxMessage } from "@moltentech/protocol/wallet";
import { handleCheckout } from "./payments.js";
import {
  afterPeriodPlan,
  applyCouponAfterPeriod,
  couponSessionArgs,
  ensureCoupon,
  verifyCoupon,
  MD,
} from "./coupon.js";
import type { StripeLike } from "./stripe.js";

const OWNER_KEY = new Uint8Array(32).fill(0x22);
const OTHER_KEY = new Uint8Array(32).fill(0x33);
const OWNER = signFluxMessage(OWNER_KEY, "x").address;

const claim = (over: Partial<CouponClaim["coupon"]> = {}, top: Partial<CouponClaim> = {}): CouponClaim => ({
  providerSlug: "moltentech",
  tier: "cumulus",
  recipient: null,
  token: "a".repeat(64),
  expiresAt: "2099-01-01T00:00:00.000Z",
  coupon: {
    name: "HALFOFF30",
    discountPct: 50,
    termMonths: 3,
    afterPct: 0,
    maxUses: 100,
    oncePerCustomer: true,
    firstRentalOnly: false,
    ...over,
  },
  ...top,
});
const sign = (c: CouponClaim, key = OWNER_KEY): SignedCoupon => ({ claim: c, signature: signFluxMessage(key, couponMessage(c)).signature });
const CFG = { providerSlug: "moltentech", ownerAddress: OWNER, tierPrices: { cumulus: 1000 }, trialDays: 1 };

test("🔒 couponMessage is byte-identical to what the hub signs (2a, 2.2.73)", () => {
  assert.equal(
    couponMessage(claim()),
    [
      "Flux Hub coupon",
      "provider: moltentech",
      "code: HALFOFF30",
      "tier: cumulus",
      "recipient: anyone",
      "discount: 50% off",
      "for: 3 months",
      "then: full price",
      "uses: 100",
      "once per customer: yes",
      "first rental only: no",
      `token: ${"a".repeat(64)}`,
      "expires: 2099-01-01T00:00:00.000Z",
    ].join("\n")
  );
});

test("verifyCoupon: only the owner's signature, for this provider and tier, before it expires", () => {
  assert.equal(verifyCoupon(CFG, "cumulus", sign(claim())).ok, true);
  const no = (s: SignedCoupon, tier = "cumulus", cfg: any = CFG) => {
    const v = verifyCoupon(cfg, tier, s);
    return v.ok ? "ok" : v.reason;
  };
  assert.match(no(sign(claim(), OTHER_KEY)), /signature/);
  assert.match(no(sign(claim()), "nimbus"), /for cumulus, not nimbus/);
  assert.match(no(sign(claim({}, { providerSlug: "other" }))), /for other/);
  assert.match(no(sign(claim({}, { expiresAt: "2020-01-01T00:00:00.000Z" }))), /expired/);
  assert.match(no(sign(claim()), "cumulus", { ...CFG, ownerAddress: undefined }), /OWNER_ADDRESS/);
  // The hub (or anyone between) bumps the discount after signing: the bytes no longer match.
  const s = sign(claim());
  const tampered: SignedCoupon = { ...s, claim: { ...s.claim, coupon: { ...s.claim.coupon, discountPct: 100 } } };
  assert.match(no(tampered), /signature/);
});

test("session args: 100 % for N months is a trial to the calendar date; partial is a coupon", () => {
  const now = new Date("2026-11-11T15:00:00Z");
  const free = couponSessionArgs(claim({ discountPct: 100 }).coupon, null, now);
  assert.equal(free.trialEnd, Math.floor(addCalendarMonths(now, 3).getTime() / 1000));
  assert.equal(new Date(free.trialEnd! * 1000).toISOString(), "2027-02-11T15:00:00.000Z");
  assert.equal(free.discounts, undefined);
  const half = couponSessionArgs(claim().coupon, "HALFOFF30", now);
  assert.deepEqual(half.discounts, [{ coupon: "HALFOFF30" }]);
  assert.equal(half.trialEnd, undefined);
  assert.equal(half.metadata[MD.after], "0");
});

function fakeStripe(existing: Record<string, Record<string, unknown>> = {}) {
  const sessions: Record<string, any>[] = [];
  const created: Record<string, any>[] = [];
  const stripe = {
    prices: { list: async () => ({ data: [{ id: "price_1" }] }) },
    checkout: { sessions: { create: async (a: Record<string, any>) => (sessions.push(a), { url: "https://checkout.stripe.test/s/1" }) } },
    coupons: {
      retrieve: async (id: string) => {
        if (existing[id]) return existing[id];
        throw Object.assign(new Error("No such coupon"), { statusCode: 404 });
      },
      create: async (a: Record<string, any>) => (created.push(a), (existing[a.id] = a), { id: a.id }),
    },
  } as unknown as StripeLike;
  return { stripe, sessions, created };
}
const REQ = {
  schemaVersion: 1,
  providerSlug: "moltentech",
  tier: "cumulus",
  customer: { mtCustomerId: "cust_1", email: "renter@example.com" },
  idempotencyKey: "k1",
  successUrl: "https://hub.test/ok",
  cancelUrl: "https://hub.test/no",
} as any;

test("checkout with a partial coupon: coupon applied, no promo box, usual trial kept", async () => {
  const { stripe, sessions, created } = fakeStripe();
  const out = await handleCheckout(stripe, CFG as any, { ...REQ, coupon: sign(claim()) });
  assert.equal(out.couponApplied, "HALFOFF30");
  const s = sessions[0]!;
  assert.deepEqual(s.discounts, [{ coupon: "HALFOFF30" }]);
  assert.equal(s.allow_promotion_codes, undefined);
  assert.equal(s.subscription_data.trial_period_days, 1);
  assert.equal(s.subscription_data.metadata[MD.name], "HALFOFF30");
  assert.deepEqual(created[0], { id: "HALFOFF30", name: "HALFOFF30", percent_off: 50, duration: "repeating", duration_in_months: 3 });
});

test("checkout with a 100 % coupon: a trial to the 3-month date, no Stripe coupon at all", async () => {
  const { stripe, sessions, created } = fakeStripe();
  await handleCheckout(stripe, CFG as any, { ...REQ, coupon: sign(claim({ discountPct: 100, afterPct: -1 })) });
  const s = sessions[0]!;
  assert.ok(s.subscription_data.trial_end > Date.now() / 1000 + 80 * 86400);
  assert.equal(s.subscription_data.trial_period_days, undefined);
  assert.equal(s.discounts, undefined);
  assert.equal(created.length, 0);
});

test("a refused coupon fails the checkout — never a silent full-price charge", async () => {
  const { stripe, sessions } = fakeStripe();
  await assert.rejects(handleCheckout(stripe, CFG as any, { ...REQ, coupon: sign(claim(), OTHER_KEY) }), /coupon refused/);
  assert.equal(sessions.length, 0);
});

test("no coupon: unchanged — the promotion code box stays", async () => {
  const { stripe, sessions } = fakeStripe();
  const out = await handleCheckout(stripe, CFG as any, REQ);
  assert.equal(sessions[0]!.allow_promotion_codes, true);
  assert.equal(out.couponApplied, undefined);
});

test("ensureCoupon: reuse a matching coupon, never re-read different terms as this offer", async () => {
  const same = fakeStripe({ HALFOFF30: { id: "HALFOFF30", percent_off: 50, duration: "repeating", duration_in_months: 3 } });
  assert.equal(await ensureCoupon(same.stripe, "HALFOFF30", 50, 3), "HALFOFF30");
  assert.equal(same.created.length, 0);
  const other = fakeStripe({ HALFOFF30: { id: "HALFOFF30", percent_off: 25, duration: "forever" } });
  assert.equal(await ensureCoupon(other.stripe, "HALFOFF30", 50, 3), "HALFOFF30-50-3");
  assert.equal(other.created[0]!.id, "HALFOFF30-50-3");
  assert.equal(await ensureCoupon(other.stripe, "HALFOFF30", 50, 3), "HALFOFF30-50-3", "a retry finds the first try's coupon");
});

// ── after the period ────────────────────────────────────────────────────────────────────

const md = (pct: number, months: number, after: number) => ({
  [MD.name]: "CODE1",
  [MD.pct]: String(pct),
  [MD.months]: String(months),
  [MD.after]: String(after),
});
const T0 = Math.floor(Date.parse("2026-11-11T15:00:00Z") / 1000);
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

test("after plan: full price needs nothing; no coupon needs nothing", () => {
  assert.deepEqual(afterPeriodPlan({ metadata: md(50, 3, 0), start_date: T0 }), { kind: "none" });
  assert.deepEqual(afterPeriodPlan({ metadata: {}, start_date: T0 }), { kind: "none" });
});

test("after plan: end the rental at the boundary — trial end for 100 %, N months after the first charge otherwise", () => {
  const trialEnd = at("2027-02-11T15:00:00Z");
  assert.deepEqual(afterPeriodPlan({ metadata: md(100, 3, -1), start_date: T0, trial_end: trialEnd }), { kind: "cancel_at", at: trialEnd });
  const oneDayTrial = at("2026-11-12T15:00:00Z");
  assert.deepEqual(afterPeriodPlan({ metadata: md(50, 3, -1), start_date: T0, trial_end: oneDayTrial }), {
    kind: "cancel_at",
    at: at("2027-02-12T15:00:00Z"),
  });
});

test("after plan: a smaller discount is a schedule with the after-% from the boundary", () => {
  const p = afterPeriodPlan({ metadata: md(50, 3, 20), start_date: T0, discounts: [{ coupon: { id: "CODE1" } }] });
  assert.deepEqual(p, { kind: "schedule", boundary: at("2027-02-11T15:00:00Z"), afterPct: 20, firstCoupon: "CODE1", trialEnd: null });
});

function subStripe(sub: Record<string, any>, coupons: Record<string, any> = {}) {
  const calls: Array<[string, any]> = [];
  const stripe = {
    subscriptions: {
      retrieve: async () => sub,
      update: async (id: string, a: any) => (calls.push(["sub.update", a]), {}),
    },
    coupons: {
      retrieve: async (id: string) => {
        if (coupons[id]) return coupons[id];
        throw Object.assign(new Error("missing"), { statusCode: 404 });
      },
      create: async (a: any) => (calls.push(["coupon.create", a]), (coupons[a.id] = a), { id: a.id }),
    },
    subscriptionSchedules: {
      create: async (a: any) => (calls.push(["sch.create", a]), { id: "sub_sched_1", phases: [{ start_date: T0 }] }),
      update: async (id: string, a: any) => (calls.push(["sch.update", a]), {}),
    },
  } as unknown as StripeLike;
  return { stripe, calls };
}
const created = (o: Record<string, any>) => ({ id: "evt_1", type: "customer.subscription.created", data: { object: o } });

test("apply: 50 % × 3 then 20 % — schedule built like the test-clock run", async () => {
  const o = { id: "sub_1", metadata: md(50, 3, 20), start_date: T0, items: { data: [{ price: { id: "price_1" } }] } };
  // CODE1 already exists: it is the 50 % × 3 coupon the checkout applied.
  const { stripe, calls } = subStripe(
    { ...o, schedule: null, discounts: [{ coupon: { id: "CODE1" } }] },
    { CODE1: { id: "CODE1", percent_off: 50, duration: "repeating", duration_in_months: 3 } }
  );
  assert.equal(await applyCouponAfterPeriod(stripe, created(o)), true);
  assert.deepEqual(calls.map((c) => c[0]), ["coupon.create", "sch.create", "sch.update"]);
  assert.deepEqual(calls[0]![1], { id: "CODE1-20-F", name: "CODE1", percent_off: 20, duration: "forever" });
  assert.deepEqual(calls[1]![1], { from_subscription: "sub_1" });
  const upd = calls[2]![1];
  assert.equal(upd.end_behavior, "release");
  assert.equal(upd.phases[0].start_date, T0);
  assert.equal(upd.phases[0].end_date, at("2027-02-11T15:00:00Z"));
  assert.deepEqual(upd.phases[0].discounts, [{ coupon: "CODE1" }], "phase 0 keeps the 50 %");
  assert.deepEqual(upd.phases[1].discounts, [{ coupon: "CODE1-20-F" }], "phase 1 is the 20 % forever");
  assert.deepEqual(upd.phases[1].items, [{ price: "price_1" }]);
});

test("apply: idempotent — a re-delivery finds the schedule / cancel_at and does nothing", async () => {
  const o = { id: "sub_1", metadata: md(50, 3, 20), start_date: T0, items: { data: [{ price: { id: "price_1" } }] } };
  const a = subStripe({ ...o, schedule: "sub_sched_1" });
  assert.equal(await applyCouponAfterPeriod(a.stripe, created(o)), true);
  assert.equal(a.calls.length, 0);
  const o2 = { id: "sub_2", metadata: md(100, 3, -1), start_date: T0, trial_end: at("2027-02-11T15:00:00Z") };
  const b = subStripe({ ...o2, cancel_at: at("2027-02-11T15:00:00Z") });
  assert.equal(await applyCouponAfterPeriod(b.stripe, created(o2)), true);
  assert.equal(b.calls.length, 0);
});

test("apply: -1 sets cancel_at with no proration; a Stripe error returns false (webhook 502s)", async () => {
  const o = { id: "sub_3", metadata: md(100, 1, -1), start_date: T0, trial_end: at("2026-12-11T15:00:00Z") };
  const ok = subStripe({ ...o, cancel_at: null });
  assert.equal(await applyCouponAfterPeriod(ok.stripe, created(o)), true);
  assert.deepEqual(ok.calls[0], ["sub.update", { cancel_at: at("2026-12-11T15:00:00Z"), proration_behavior: "none" }]);
  const broken = subStripe({ ...o, cancel_at: null });
  (broken.stripe.subscriptions as any).update = async () => {
    throw new Error("stripe down");
  };
  assert.equal(await applyCouponAfterPeriod(broken.stripe, created(o)), false);
});
