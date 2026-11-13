/**
 * Operator coupons on card (hub plan `operator_coupons_plan.md`, § Option H): the Coalition
 * discounts only a coupon its OWN owner wallet signed, and charges it as the line's price
 * (`price_data`), never as a Stripe coupon, trial end, `cancel_at` or schedule.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { couponMessage, type CouponClaim, type SignedCoupon } from "@moltentech/protocol";
import { signFluxMessage } from "@moltentech/protocol/wallet";
import { handleCheckout, handleManage } from "./payments.js";
import { couponPriceCents, verifyCoupon, MD } from "./coupon.js";
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

test("couponPriceCents: tier × (1 − pct), rounded DOWN — never a cent over the offer", () => {
  assert.equal(couponPriceCents(1000, 50), 500);
  assert.equal(couponPriceCents(700, 100), 0);
  assert.equal(couponPriceCents(999, 33), 669); // 669.33 → 669
  assert.equal(couponPriceCents(1, 50), 0);
  assert.equal(couponPriceCents(1000, 1), 990);
});

function fakeStripe() {
  const sessions: Record<string, any>[] = [];
  const updates: [string, Record<string, any>][] = [];
  const stripe = {
    prices: { list: async () => ({ data: [{ id: "price_1", product: "prod_1" }] }) },
    checkout: { sessions: { create: async (a: Record<string, any>) => (sessions.push(a), { url: "https://checkout.stripe.test/s/1" }) } },
    subscriptions: {
      update: async (id: string, a: Record<string, any>) => (updates.push([id, a]), {}),
      cancel: async () => ({}),
    },
  } as unknown as StripeLike;
  return { stripe, sessions, updates };
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

test("checkout with a partial coupon: the line IS the discounted price, usual trial kept, no promo box", async () => {
  const { stripe, sessions } = fakeStripe();
  const out = await handleCheckout(stripe, CFG as any, { ...REQ, coupon: sign(claim()) });
  assert.equal(out.couponApplied, "HALFOFF30");
  assert.equal(out.chargedCents, 500);
  assert.equal(out.priceCents, 1000, "priceCents stays the listed tier price");
  const s = sessions[0]!;
  assert.deepEqual(s.line_items, [
    { price_data: { currency: "usd", product: "prod_1", unit_amount: 500, recurring: { interval: "month" } }, quantity: 1 },
  ]);
  assert.equal(s.discounts, undefined, "no Stripe coupon (option H)");
  assert.equal(s.allow_promotion_codes, undefined);
  assert.equal(s.subscription_data.trial_period_days, 1);
  assert.equal(s.subscription_data.trial_end, undefined);
  assert.equal(s.subscription_data.metadata[MD.name], "HALFOFF30");
  assert.equal(s.subscription_data.metadata[MD.pct], "50");
  assert.equal(s.payment_method_collection, "always");
});

test("checkout with a 100 % coupon: a $0 line, NO trial, card still collected (H-D2)", async () => {
  const { stripe, sessions } = fakeStripe();
  const out = await handleCheckout(stripe, CFG as any, { ...REQ, coupon: sign(claim({ discountPct: 100, afterPct: -1 })) });
  assert.equal(out.chargedCents, 0);
  const s = sessions[0]!;
  assert.equal(s.line_items[0].price_data.unit_amount, 0);
  assert.equal(s.subscription_data.trial_period_days, undefined);
  assert.equal(s.subscription_data.trial_end, undefined);
  assert.equal(s.payment_method_collection, "always");
});

test("an 'always' coupon is the same line: the price never changes, nothing scheduled", async () => {
  const { stripe, sessions } = fakeStripe();
  const out = await handleCheckout(stripe, CFG as any, { ...REQ, coupon: sign(claim({ discountPct: 25, termMonths: null, afterPct: null })) });
  assert.equal(out.chargedCents, 750);
  assert.equal(sessions[0]!.line_items[0].price_data.unit_amount, 750);
});

test("a refused coupon fails the checkout — never a silent full-price charge", async () => {
  const { stripe, sessions } = fakeStripe();
  await assert.rejects(handleCheckout(stripe, CFG as any, { ...REQ, coupon: sign(claim(), OTHER_KEY) }), /coupon refused/);
  assert.equal(sessions.length, 0);
});

test("no coupon: unchanged — the tier price object, the promotion code box, the usual trial", async () => {
  const { stripe, sessions } = fakeStripe();
  const out = await handleCheckout(stripe, CFG as any, REQ);
  const s = sessions[0]!;
  assert.deepEqual(s.line_items, [{ price: "price_1", quantity: 1 }]);
  assert.equal(s.allow_promotion_codes, true);
  assert.equal(s.subscription_data.trial_period_days, 1);
  assert.equal(s.subscription_data.metadata[MD.name], undefined);
  assert.equal(out.couponApplied, undefined);
  assert.equal(out.chargedCents, undefined);
});

test("manage cancel_at_period_end: stops at the period end, no immediate cancel (H-D1)", async () => {
  const { stripe, updates } = fakeStripe();
  const out = await handleManage(stripe, { schemaVersion: 1, providerSlug: "moltentech", action: "cancel_at_period_end", stripeSubscriptionId: "sub_1" } as any);
  assert.equal(out.ok, true);
  assert.deepEqual(updates, [["sub_1", { cancel_at_period_end: true }]]);
});
