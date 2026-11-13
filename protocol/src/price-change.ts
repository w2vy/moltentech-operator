import { z } from "zod";
import { Envelope, ProviderSlug, TierKey } from "./common";
import { CouponTerms, SignedCoupon } from "./coupon";

/**
 * Coupon after-period price change (hub plan `operator_coupons_plan.md` § Option H, 3c).
 *
 * A card coupon is the subscription item's PRICE (Coalition 0.9.0). When its period ends and
 * the coupon says "then: full price" or "then: N% off", the item's price has to change — and
 * raising what a customer pays is the operator's decision, so the operator signs each change
 * with their owner wallet. The hub queues it, the agent carries it to the Coalition console,
 * the operator signs, the agent relays the signature to the hub, and the hub calls the
 * Coalition's `POST /price` at the right time. The Coalition re-checks the signature against
 * its own `OWNER_ADDRESS` and the amount against the signed coupon before touching Stripe.
 *
 * Unsigned by the renewal: that renewal charges what the item already says (the customer
 * keeps the discount, tom 2026-11-12); the hub queues a fresh change for the next one.
 *
 * 🔒 `priceChangeMessage` IS the signed preimage. Both sides must produce identical bytes.
 */

/** Cents as the wallet shows them: `$7.00`. */
export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export const PriceChangeClaim = z.object({
  /** The hub's id for this queued change. One signature binds to one change. */
  changeId: z.string().min(1).max(64),
  providerSlug: ProviderSlug,
  rentalCode: z.string().min(1),
  stripeSubscriptionId: z.string().min(1),
  couponCode: CouponTerms.shape.name,
  tier: TierKey,
  /** What the item charges now (the coupon price). */
  fromCents: z.number().int().nonnegative(),
  /** What it charges from `firstChargeOn` on: tier × (1 − afterPct), or the tier price. */
  toCents: z.number().int().positive(),
  /** The renewal that first charges `toCents`, `YYYY-MM-DD` (UTC). Shown to the operator. */
  firstChargeOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type PriceChangeClaim = z.infer<typeof PriceChangeClaim>;

/** The exact bytes the operator's wallet signs for a price change. Written to be read in a wallet. */
export function priceChangeMessage(c: PriceChangeClaim): string {
  return [
    "Flux Hub price change",
    `provider: ${c.providerSlug}`,
    `rental: ${c.rentalCode}`,
    `subscription: ${c.stripeSubscriptionId}`,
    `coupon: ${c.couponCode}`,
    `tier: ${c.tier}`,
    `from: ${formatUsd(c.fromCents)}/month`,
    `to: ${formatUsd(c.toCents)}/month`,
    `first charge: ${c.firstChargeOn}`,
    `id: ${c.changeId}`,
  ].join("\n");
}

export const SignedPriceChange = z.object({
  claim: PriceChangeClaim,
  signature: z.string().min(1),
});
export type SignedPriceChange = z.infer<typeof SignedPriceChange>;

// ── price  —  MT → operator Coalition (Coalition 0.10.0+). Auth: the hub's request signature. ──
export const PriceChangeRequest = Envelope.extend({
  providerSlug: ProviderSlug,
  /** The operator-signed change (relayed by the agent from the console). */
  change: SignedPriceChange,
  /** The operator-signed coupon the rental started on: the Coalition re-derives `toCents` from it. */
  coupon: SignedCoupon,
});
export type PriceChangeRequest = z.infer<typeof PriceChangeRequest>;

export const PriceChangeResponse = Envelope.extend({
  ok: z.literal(true),
  /** The item already charged `toCents` (a retry): nothing changed at Stripe. */
  alreadyApplied: z.boolean(),
  /** The monthly price the item charges now. */
  chargedCents: z.number().int().positive(),
});
export type PriceChangeResponse = z.infer<typeof PriceChangeResponse>;

/**
 * The after-period price a coupon signs for: `afterPct` 0 = the tier price, N = tier × (1 − N),
 * rounded down (the same rule as the coupon price). Null when the coupon has no price after
 * its period: "always", or "then: end the rental".
 */
export function afterPeriodCents(tierCents: number, terms: CouponTerms): number | null {
  if (terms.termMonths === null || terms.afterPct === null || terms.afterPct < 0) return null;
  return Math.floor((tierCents * (100 - terms.afterPct)) / 100);
}
