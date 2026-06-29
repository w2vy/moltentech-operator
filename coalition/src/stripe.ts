import Stripe from "stripe";

/**
 * The narrow slice of Stripe the Coalition uses, as an interface so the payment
 * logic can be unit-tested with a fake (real Stripe calls need live keys).
 */
export type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

export interface StripeLike {
  checkout: { sessions: { create(args: Record<string, unknown>): Promise<{ url: string | null }> } };
  billingPortal: { sessions: { create(args: Record<string, unknown>): Promise<{ url: string }> } };
  subscriptions: {
    retrieve(id: string): Promise<{ customer: string | { id: string } }>;
    cancel(id: string): Promise<unknown>;
  };
  prices: {
    search(args: { query: string }): Promise<{ data: { id: string }[] }>;
    create(args: Record<string, unknown>): Promise<{ id: string }>;
  };
  products: { create(args: Record<string, unknown>): Promise<{ id: string }> };
  webhooks: { constructEvent(payload: string | Buffer, sig: string, secret: string): StripeEvent };
}

/** Wrap the real Stripe SDK as a StripeLike. */
export function createStripe(secretKey: string): StripeLike {
  const s = new Stripe(secretKey, { apiVersion: "2025-02-24.acacia", typescript: true });
  return s as unknown as StripeLike;
}

/**
 * Idempotently materialize the operator's recurring Price for (tier, priceCents)
 * via a deterministic lookup_key, so the single declared price flows straight into
 * Stripe with no stored Price IDs. Returns the Stripe Price id.
 */
export async function ensurePrice(
  stripe: StripeLike,
  slug: string,
  tier: string,
  priceCents: number
): Promise<string> {
  const lookupKey = `mt-${slug}-${tier}-${priceCents}`;
  const found = await stripe.prices.search({ query: `lookup_key:'${lookupKey}'` });
  if (found.data[0]) return found.data[0].id;

  const product = await stripe.products.create({ name: `MoltenTech ${tier.toUpperCase()} (${slug})` });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: priceCents,
    currency: "usd",
    recurring: { interval: "month" },
    lookup_key: lookupKey,
  });
  return price.id;
}
