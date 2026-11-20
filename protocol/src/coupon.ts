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
  /** Upper-cased code. (Coalition 0.8.0 also used it as a Stripe coupon id; 0.9.0 makes no Stripe coupons.) */
  name: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,23}$/),
  /** % off during the period. 100 = free (a $0 line on card, Coalition 0.9.0). */
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
  /**
   * The coupon's tier. On a multi-tier coupon (`tiers` set) this is NOT in the signed bytes —
   * it is `tiers[0]`, kept so the field stays required for older readers. Read `couponTiers()`.
   */
  tier: z.string().min(1),
  /**
   * Several tiers (Coalition 0.17.0, tom 2026-11-19): the operator checked 2 or more tiers when
   * issuing. Absent = the one `tier`, and the signed bytes are exactly as before. An older
   * Coalition drops this field, rebuilds a `tier:` line and refuses the signature — it never
   * discounts a tier the operator did not sign for.
   */
  tiers: z.array(z.string().min(1)).min(2).optional(),
  /** Null = anyone with the code. */
  recipient: z.string().nullable(),
  /** 256-bit hex nonce, unique per coupon. */
  token: z.string().regex(/^[0-9a-f]{64}$/),
  /** Code valid until (ISO). */
  expiresAt: z.string().min(1),
  coupon: CouponTerms,
});
export type CouponClaim = z.infer<typeof CouponClaim>;

/** The tiers a coupon may be used on: `tiers` when set, else the one `tier`. */
export function couponTiers(claim: Pick<CouponClaim, "tier" | "tiers">): string[] {
  return claim.tiers && claim.tiers.length > 0 ? claim.tiers : [claim.tier];
}

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
    // A one-tier coupon keeps its `tier:` line byte for byte; several tiers are one `tiers:` line.
    claim.tiers && claim.tiers.length > 0 ? `tiers: ${claim.tiers.join(", ")}` : `tier: ${claim.tier}`,
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
 * FLUX terms (`addMonths`) and Stripe's monthly renewals, so a coupon period ends on the same
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
