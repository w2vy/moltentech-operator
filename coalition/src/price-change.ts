import {
  SCHEMA_VERSION,
  afterPeriodCents,
  formatUsd,
  priceChangeMessage,
  type PriceChangeRequest,
  type PriceChangeResponse,
} from "@moltentech/protocol";
import { verifyFluxSignature } from "@moltentech/protocol/wallet";
import type { CoalitionConfig } from "./config";
import { verifyCoupon, MD } from "./coupon";
import { ensureTierPrice, type StripeLike } from "./stripe";

/**
 * `POST /price` — a coupon's after-period price change (hub plan § Option H, 3c).
 *
 * The hub calls this with TWO operator signatures: the price change the operator signed in
 * this console, and the coupon the rental started on. Both are checked against our own
 * `OWNER_ADDRESS`, and the new amount is re-derived from the signed coupon, so the hub alone
 * can neither raise a customer's price nor pick the number. Then the subscription's one item
 * gets the new price with no proration: the next invoice carries it (tested 2026-11-12).
 */

/** A correct "no" (bad signature, wrong amount, stale change): the hub must not retry it. */
export class PriceChangeRefused extends Error {}

const refuse = (reason: string): never => {
  throw new PriceChangeRefused(reason);
};

type SubItem = { id: string; price?: { unit_amount?: number | null; product?: string | { id: string } } };

export async function handlePriceChange(
  stripe: StripeLike,
  cfg: Pick<CoalitionConfig, "providerSlug" | "ownerAddress" | "tierPrices">,
  req: PriceChangeRequest,
  now: Date = new Date()
): Promise<PriceChangeResponse> {
  const c = req.change.claim;
  if (!cfg.ownerAddress) refuse("no OWNER_ADDRESS — this Coalition cannot verify a price change");
  if (req.providerSlug !== cfg.providerSlug || c.providerSlug !== cfg.providerSlug) {
    refuse(`price change is for ${c.providerSlug}, not ${cfg.providerSlug}`);
  }
  if (!verifyFluxSignature(cfg.ownerAddress!, priceChangeMessage(c), req.change.signature)) {
    refuse("price change signature does not match OWNER_ADDRESS");
  }

  // The coupon may have closed for new customers long ago; this rental already redeemed it.
  const v = verifyCoupon(cfg, c.tier, req.coupon, now, { redeemed: true });
  if (!v.ok) return refuse(`coupon refused: ${v.reason}`);
  if (v.terms.name !== c.couponCode) refuse(`price change is for coupon ${c.couponCode}, the coupon sent is ${v.terms.name}`);

  const tierCents = cfg.tierPrices[c.tier];
  if (!tierCents) return refuse(`no price configured for tier ${c.tier}`);
  const expected = afterPeriodCents(tierCents, v.terms);
  if (expected === null) return refuse(`coupon ${c.couponCode} has no price after its period`);
  if (c.toCents !== expected) {
    refuse(`coupon ${c.couponCode} sets ${formatUsd(expected)} after its period, the signed change says ${formatUsd(c.toCents)}`);
  }

  const sub = (await stripe.subscriptions.retrieve(c.stripeSubscriptionId)) as Record<string, any>;
  if (sub.status === "canceled" || sub.status === "incomplete_expired") refuse(`subscription is ${sub.status}`);
  const md = (sub.metadata ?? {}) as Record<string, string>;
  if (md[MD.name] !== c.couponCode) refuse(`subscription did not start on coupon ${c.couponCode}`);
  if (md.tier && md.tier !== c.tier) refuse(`subscription is for ${md.tier}, not ${c.tier}`);
  if (md.rentalCode && md.rentalCode !== c.rentalCode) refuse(`subscription is rental ${md.rentalCode}, not ${c.rentalCode}`);

  // One item per subscription today. The per-customer subscription plan (one item per node)
  // will pick the item by its rental code; until then, refuse rather than guess.
  const items = (sub.items?.data ?? []) as SubItem[];
  if (items.length !== 1) return refuse(`subscription has ${items.length} items, expected 1`);
  const item = items[0]!;
  const current = item.price?.unit_amount ?? null;
  const base = { schemaVersion: SCHEMA_VERSION, ok: true as const, chargedCents: c.toCents };
  if (current === c.toCents) return { ...base, alreadyApplied: true };
  if (current !== c.fromCents) {
    refuse(`the item charges ${current === null ? "an unknown price" : formatUsd(current)}, the signed change is from ${formatUsd(c.fromCents)}`);
  }

  // Back to full price = back on the tier's catalogue price (what a plain checkout uses).
  // A lasting discount = an inline price on the same product, like the coupon period.
  let priceArg: Record<string, unknown>;
  if (c.toCents === tierCents) {
    priceArg = { price: (await ensureTierPrice(stripe, cfg.providerSlug, c.tier, tierCents)).priceId };
  } else {
    const p = item.price?.product;
    const product = typeof p === "string" ? p : p?.id;
    if (!product) return refuse("the subscription item has no product");
    priceArg = { price_data: { currency: "usd", product, unit_amount: c.toCents, recurring: { interval: "month" } } };
  }
  await stripe.subscriptions.update(c.stripeSubscriptionId, {
    items: [{ id: item.id, ...priceArg }],
    proration_behavior: "none",
    metadata: { [MD.priceChange]: c.changeId },
  });
  console.log(
    `[price] ${c.rentalCode} ${c.stripeSubscriptionId}: ${formatUsd(c.fromCents)} → ${formatUsd(c.toCents)}/month (coupon ${c.couponCode}, change ${c.changeId})`
  );
  return { ...base, alreadyApplied: false };
}
