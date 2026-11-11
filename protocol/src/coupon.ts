import { z } from "zod";

/**
 * Operator coupons — a coupon is a NAMED grant the operator signs with their owner wallet
 * (hub plan `operator_coupons_plan.md`, 2026-11-11). Shared by the hub, which builds and
 * stores the signed claim, and the Coalition, which re-verifies it against its own
 * `OWNER_ADDRESS` before it discounts anything on the operator's Stripe account.
 *
 * 🔒 `couponMessage` IS the signed preimage. Both sides must produce identical bytes, which
 * is why it lives here and not in either app. Changing a line invalidates every coupon
 * already issued.
 */

export const CouponTerms = z.object({
  /** Upper-cased code; also the Stripe coupon id on the operator's account. */
  name: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,23}$/),
  /** % off during the period. 100 = free (a Stripe trial on card). */
  discountPct: z.number().int().min(1).max(100),
  /** Period in CALENDAR months, or null = the discount never ends. */
  termMonths: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
  /** After the period: 0 full price, 1–99 that % off, -1 end the rental. Null when `termMonths` is null. */
  afterPct: z.number().int().min(-1).max(99).nullable(),
  maxUses: z.number().int().min(1).max(10_000),
  oncePerCustomer: z.boolean(),
  firstRentalOnly: z.boolean(),
});
export type CouponTerms = z.infer<typeof CouponTerms>;

/** The whole signed claim of a coupon (the hub's `GrantClaim` with `coupon` set). */
export const CouponClaim = z.object({
  providerSlug: z.string().min(1),
  tier: z.string().min(1),
  /** Null = anyone with the code. */
  recipient: z.string().nullable(),
  /** 256-bit hex nonce, unique per coupon. */
  token: z.string().regex(/^[0-9a-f]{64}$/),
  /** Code valid until (ISO). */
  expiresAt: z.string().min(1),
  coupon: CouponTerms,
});
export type CouponClaim = z.infer<typeof CouponClaim>;

function afterLine(t: CouponTerms): string {
  if (t.afterPct === -1) return "end the rental";
  if (t.afterPct === 0) return "full price";
  return `${t.afterPct}% off`;
}

/** The exact bytes the operator's wallet signs for a coupon. Written to be read in a wallet. */
export function couponMessage(claim: CouponClaim): string {
  const t = claim.coupon;
  return [
    "Flux Hub coupon",
    `provider: ${claim.providerSlug}`,
    `code: ${t.name}`,
    `tier: ${claim.tier}`,
    `recipient: ${claim.recipient ?? "anyone"}`,
    `discount: ${t.discountPct}% off`,
    `for: ${t.termMonths === null ? "always" : `${t.termMonths} month${t.termMonths === 1 ? "" : "s"}`}`,
    ...(t.termMonths === null ? [] : [`then: ${afterLine(t)}`]),
    `uses: ${t.maxUses}`,
    `once per customer: ${t.oncePerCustomer ? "yes" : "no"}`,
    `first rental only: ${t.firstRentalOnly ? "yes" : "no"}`,
    `token: ${claim.token}`,
    `expires: ${claim.expiresAt}`,
  ].join("\n");
}

/**
 * Calendar months, clamped to the month end (01-31 + 1 → 02-28). The SAME rule as the hub's
 * FLUX terms (`addMonths`) and Stripe's month phases, so a coupon period ends on the same
 * date whichever way the customer pays.
 */
export function addCalendarMonths(from: Date, months: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(from.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(y, m, d, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds())
  );
}

/** What the hub sends with a card checkout: the stored claim and the operator's signature over it. */
export const SignedCoupon = z.object({
  claim: CouponClaim,
  signature: z.string().min(1),
});
export type SignedCoupon = z.infer<typeof SignedCoupon>;
