import { couponMessage, type CouponTerms, type SignedCoupon } from "@moltentech/protocol";
import { verifyFluxSignature } from "@moltentech/protocol/wallet";
import type { CoalitionConfig } from "./config";

/**
 * Operator coupons on the card side (hub plan `operator_coupons_plan.md`, § Option H).
 *
 * The hub decides WHO may use a code and counts uses; it has no Stripe key. The Coalition
 * holds the key, so it is the one that charges a coupon price — and it does so only for a
 * coupon the OPERATOR signed. The signature is checked here against our own
 * `OWNER_ADDRESS`, never against anything the hub says, so the hub alone cannot discount an
 * operator's sales. (It could replay a genuine coupon beyond its use limit; the count is the
 * hub's job and the operator can see it on their Grants page.)
 *
 * Option H (tom 2026-11-12/13): a coupon is the ITEM'S PRICE, never a Stripe coupon. The
 * subscription's line is `price_data` at tier × (1 − pct), rounded down — a 100 % period is
 * a $0 line, not a trial. Nothing about the after-period is put on the subscription: the hub
 * ends a "then: end the rental" coupon itself, and a price change after the period is a
 * separate operator-signed step. This replaced 0.8.0's repeating coupons / `trial_end` /
 * `cancel_at` / schedules, which leaked onto every item of a shared subscription.
 */

export type CouponVerdict = { ok: true; terms: CouponTerms } | { ok: false; reason: string };

/** Is this the operator's own coupon, for this tier, still valid? Pure apart from the clock. */
export function verifyCoupon(
  cfg: Pick<CoalitionConfig, "providerSlug" | "ownerAddress">,
  tier: string,
  signed: SignedCoupon,
  now: Date = new Date(),
  /**
   * Skip the "code valid until" check. Only for a coupon ALREADY redeemed: a price change at
   * the end of its period (3c, `POST /price`) comes months after the code may have closed.
   */
  opts: { redeemed?: boolean } = {}
): CouponVerdict {
  if (!cfg.ownerAddress) return { ok: false, reason: "no OWNER_ADDRESS — this Coalition cannot verify a coupon" };
  const c = signed.claim;
  if (c.providerSlug !== cfg.providerSlug) return { ok: false, reason: `coupon is for ${c.providerSlug}, not ${cfg.providerSlug}` };
  if (c.tier !== tier) return { ok: false, reason: `coupon is for ${c.tier}, not ${tier}` };
  const expires = new Date(c.expiresAt);
  if (!opts.redeemed && (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime())) {
    return { ok: false, reason: "coupon has expired" };
  }
  if (!verifyFluxSignature(cfg.ownerAddress, couponMessage(c), signed.signature)) {
    return { ok: false, reason: "coupon signature does not match OWNER_ADDRESS" };
  }
  return { ok: true, terms: c.coupon };
}

/**
 * The price a coupon charges: tier × (1 − pct), in cents, rounded DOWN so the customer is
 * never charged a cent more than the offer. The same rule as the hub's FLUX quote, so one
 * code costs the same on both rails.
 */
export function couponPriceCents(tierCents: number, pct: number): number {
  return Math.floor((tierCents * (100 - pct)) / 100);
}

/** Subscription metadata that records which coupon a rental started on (read by people, not code). */
export const MD = { name: "mtCoupon", pct: "mtCouponPct", priceChange: "mtPriceChange" } as const;
