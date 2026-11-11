import { addCalendarMonths, couponMessage, type CouponTerms, type SignedCoupon } from "@moltentech/protocol";
import { verifyFluxSignature } from "@moltentech/protocol/wallet";
import type { CoalitionConfig } from "./config";
import type { StripeEvent, StripeLike } from "./stripe";

/**
 * Operator coupons on the card side (hub plan `operator_coupons_plan.md`, phase 3).
 *
 * The hub decides WHO may use a code and counts uses; it has no Stripe key. The Coalition
 * holds the key, so it is the one that turns a coupon into Stripe terms — and it does so only
 * for a coupon the OPERATOR signed. The signature is checked here against our own
 * `OWNER_ADDRESS`, never against anything the hub says, so the hub alone cannot discount an
 * operator's sales. (It could replay a genuine coupon beyond its use limit; the count is the
 * hub's job and the operator can see it on their Grants page.)
 *
 * How each coupon maps (proven on a Stripe test clock 2026-11-11):
 *   - 100 % for N months → a trial ending on the N-calendar-month date (`trial_end`).
 *   - partial % for N months → a `repeating` Stripe coupon for N months.
 *   - always → a `forever` coupon.
 *   - after the period (on `subscription.created`): 0 → nothing (the discount just ends);
 *     -1 → `cancel_at` the boundary; N % → a subscription schedule whose second phase carries
 *     an N % `forever` coupon, released afterwards (the 20 % outlived the release in the test).
 */

export type CouponVerdict = { ok: true; terms: CouponTerms } | { ok: false; reason: string };

/** Is this the operator's own coupon, for this tier, still valid? Pure apart from the clock. */
export function verifyCoupon(
  cfg: Pick<CoalitionConfig, "providerSlug" | "ownerAddress">,
  tier: string,
  signed: SignedCoupon,
  now: Date = new Date()
): CouponVerdict {
  if (!cfg.ownerAddress) return { ok: false, reason: "no OWNER_ADDRESS — this Coalition cannot verify a coupon" };
  const c = signed.claim;
  if (c.providerSlug !== cfg.providerSlug) return { ok: false, reason: `coupon is for ${c.providerSlug}, not ${cfg.providerSlug}` };
  if (c.tier !== tier) return { ok: false, reason: `coupon is for ${c.tier}, not ${tier}` };
  const expires = new Date(c.expiresAt);
  if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) return { ok: false, reason: "coupon has expired" };
  if (!verifyFluxSignature(cfg.ownerAddress, couponMessage(c), signed.signature)) {
    return { ok: false, reason: "coupon signature does not match OWNER_ADDRESS" };
  }
  return { ok: true, terms: c.coupon };
}

/** Subscription metadata keys the after-period step reads back on `subscription.created`. */
export const MD = {
  name: "mtCoupon",
  pct: "mtCouponPct",
  months: "mtCouponMonths",
  after: "mtCouponAfterPct",
} as const;

/**
 * Pure: the Checkout Session arguments a coupon changes. `couponId` is the Stripe coupon to
 * apply for a partial / always discount (null for a 100 % period, which is a trial instead).
 */
export function couponSessionArgs(
  terms: CouponTerms,
  couponId: string | null,
  now: Date
): { discounts?: { coupon: string }[]; trialEnd?: number; metadata: Record<string, string> } {
  const metadata: Record<string, string> = {
    [MD.name]: terms.name,
    [MD.pct]: String(terms.discountPct),
    [MD.months]: terms.termMonths === null ? "" : String(terms.termMonths),
    [MD.after]: terms.afterPct === null ? "" : String(terms.afterPct),
  };
  if (terms.discountPct === 100 && terms.termMonths !== null) {
    return { trialEnd: Math.floor(addCalendarMonths(now, terms.termMonths).getTime() / 1000), metadata };
  }
  return { discounts: [{ coupon: couponId! }], metadata };
}

/** The Stripe coupon a set of terms needs, as Stripe's create args (id chosen by `ensureCoupon`). */
export function stripeCouponSpec(pct: number, months: number | null): Record<string, unknown> {
  return months === null
    ? { percent_off: pct, duration: "forever" }
    : { percent_off: pct, duration: "repeating", duration_in_months: months };
}

function matches(found: Record<string, any>, spec: Record<string, unknown>): boolean {
  return (
    Number(found.percent_off) === spec.percent_off &&
    found.duration === spec.duration &&
    (spec.duration !== "repeating" || found.duration_in_months === spec.duration_in_months) &&
    found.valid !== false
  );
}

/**
 * Find or create the Stripe coupon. Id = the code when that id is free or already means the
 * same terms (an operator can pre-make it in their dashboard). A code reused later with
 * different terms gets `CODE-<pct>-<months|F>`, so an old coupon is never silently re-read
 * as a new offer. Deterministic, so a retry finds what the first try made.
 */
export async function ensureCoupon(stripe: StripeLike, name: string, pct: number, months: number | null): Promise<string> {
  const spec = stripeCouponSpec(pct, months);
  for (const id of [name, `${name}-${pct}-${months ?? "F"}`]) {
    const found = await stripe.coupons.retrieve(id).catch((err: any) => {
      if (err?.statusCode === 404 || err?.code === "resource_missing") return null;
      throw err;
    });
    if (!found) {
      await stripe.coupons.create({ id, name, ...spec });
      return id;
    }
    if (matches(found, spec)) return id;
  }
  throw new Error(`Stripe coupons ${name} and ${name}-${pct}-${months ?? "F"} both exist with other terms`);
}

/** What to do after the period, decided from the subscription the checkout produced. */
export type AfterPlan =
  | { kind: "none" }
  | { kind: "cancel_at"; at: number }
  | { kind: "schedule"; boundary: number; afterPct: number; firstCoupon: string | null; trialEnd: number | null };

/**
 * Pure: read our own metadata back off the new subscription and decide the after-period step.
 * The boundary is where the coupon period ends: the trial end for a 100 % period; otherwise
 * N calendar months after the first charge (trial end, or the start when there is no trial).
 */
export function afterPeriodPlan(sub: {
  metadata?: Record<string, string>;
  trial_end?: number | null;
  start_date?: number;
  discounts?: Array<string | { coupon?: { id?: string } | null }>;
}): AfterPlan {
  const md = sub.metadata ?? {};
  if (!md[MD.name] || !md[MD.months] || md[MD.after] === "" || md[MD.after] === undefined) return { kind: "none" };
  const months = Number(md[MD.months]);
  const after = Number(md[MD.after]);
  const pct = Number(md[MD.pct]);
  if (!Number.isInteger(months) || !Number.isInteger(after) || after === 0) return { kind: "none" };

  const trialEnd = sub.trial_end ?? null;
  const firstCharge = trialEnd ?? sub.start_date ?? 0;
  const boundary =
    pct === 100 && trialEnd ? trialEnd : Math.floor(addCalendarMonths(new Date(firstCharge * 1000), months).getTime() / 1000);
  if (after === -1) return { kind: "cancel_at", at: boundary };

  const d0 = sub.discounts?.[0];
  const firstCoupon = typeof d0 === "object" && d0?.coupon?.id ? d0.coupon.id : null;
  return { kind: "schedule", boundary, afterPct: after, firstCoupon, trialEnd };
}

/**
 * On `subscription.created` (after the hub accepted it): put the after-period in place.
 * Idempotent — a re-delivery finds the schedule or `cancel_at` already there. Returns false
 * when Stripe refused, so the webhook answers 502 and Stripe brings the event back.
 */
export async function applyCouponAfterPeriod(stripe: StripeLike, event: StripeEvent): Promise<boolean> {
  const o = event.data.object as Record<string, any>;
  const id = String(o.id);
  const plan = afterPeriodPlan({ ...o, discounts: undefined });
  if (plan.kind === "none") return true;
  try {
    const sub = (await stripe.subscriptions.retrieve(id, { expand: ["discounts"] })) as Record<string, any>;
    if (plan.kind === "cancel_at") {
      if (sub.cancel_at) return true;
      await stripe.subscriptions.update(id, { cancel_at: plan.at, proration_behavior: "none" });
      console.log(`[coupon] ${id}: ends at ${new Date(plan.at * 1000).toISOString()} (coupon ${o.metadata?.[MD.name]})`);
      return true;
    }
    if (sub.schedule) return true;
    const full = afterPeriodPlan({ ...o, discounts: sub.discounts });
    if (full.kind !== "schedule") return true;
    const afterCoupon = await ensureCoupon(stripe, String(o.metadata[MD.name]), full.afterPct, null);
    const price = String(o.items?.data?.[0]?.price?.id ?? sub.items?.data?.[0]?.price?.id ?? "");
    if (!price) throw new Error("no price on the subscription");
    const sch = await stripe.subscriptionSchedules.create({ from_subscription: id });
    const phase0: Record<string, unknown> = {
      start_date: sch.phases[0]!.start_date,
      end_date: full.boundary,
      items: [{ price }],
    };
    if (full.trialEnd && full.trialEnd > Math.floor(Date.now() / 1000)) phase0.trial_end = full.trialEnd;
    if (full.firstCoupon) phase0.discounts = [{ coupon: full.firstCoupon }];
    await stripe.subscriptionSchedules.update(sch.id, {
      end_behavior: "release",
      phases: [phase0, { items: [{ price }], discounts: [{ coupon: afterCoupon }] }],
    });
    console.log(`[coupon] ${id}: ${full.afterPct}% off from ${new Date(full.boundary * 1000).toISOString()} (schedule ${sch.id})`);
    return true;
  } catch (err) {
    console.error(`[coupon] ${id}: after-period setup failed —`, err);
    return false;
  }
}
