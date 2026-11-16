import type { StripeEvent, StripeLike } from "./stripe";

const idOf = (v: unknown): string | undefined =>
  typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : undefined;

/** Subscriptions that can still charge a card. */
const LIVE = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

/**
 * One customer, one copy of each card.
 *
 * Since the hub reuses the customer's `cus_` for every rental (customer_subscription_plan.md
 * phase 2), every Stripe Checkout saves the card AGAIN: a customer who checked out three times
 * with the same card saw it three times in the billing portal (staging 2026-11-16, 4 copies of
 * one 4242 on one customer).
 *
 * Run once a new subscription's relay is accepted. The card that subscription pays with is kept;
 * every other saved card with the same fingerprint is a copy. Before a copy is removed, any live
 * subscription that pays with it, and the customer's invoice default, are moved to the kept card
 * so no renewal loses its card. A different card (a new number) has a different fingerprint and
 * is never touched.
 *
 * Never fatal, like `stampRentalCode`: the relay is already accepted. Each step logs and moves
 * on; a copy whose subscription could not be moved is left in place.
 */
export async function dedupeSavedCards(stripe: StripeLike, event: StripeEvent): Promise<void> {
  const o = event.data.object as Record<string, any>;
  const customer = idOf(o.customer);
  const keep = idOf(o.default_payment_method);
  if (!customer || !keep) return;
  try {
    const cards = (await stripe.paymentMethods.list({ customer, type: "card", limit: 100 })).data;
    const kept = cards.find((c) => c.id === keep);
    const fp = kept?.card?.fingerprint;
    if (!fp) return;
    const copies = cards.filter((c) => c.id !== keep && c.card?.fingerprint === fp).map((c) => c.id as string);
    if (copies.length === 0) return;

    const stuck = new Set<string>();
    const subs = (await stripe.subscriptions.list({ customer, status: "all", limit: 100 })).data;
    for (const s of subs) {
      const pm = idOf(s.default_payment_method);
      if (!pm || !copies.includes(pm) || !LIVE.has(String(s.status))) continue;
      try {
        await stripe.subscriptions.update(String(s.id), { default_payment_method: keep });
      } catch (err) {
        stuck.add(pm);
        console.error(`[cards] ${event.id}: could not move ${s.id} to ${keep} —`, err);
      }
    }
    const cust = await stripe.customers.retrieve(customer);
    const custDefault = idOf(cust?.invoice_settings?.default_payment_method);
    if (custDefault && copies.includes(custDefault)) {
      try {
        await stripe.customers.update(customer, { invoice_settings: { default_payment_method: keep } });
      } catch (err) {
        stuck.add(custDefault);
        console.error(`[cards] ${event.id}: could not move ${customer}'s default to ${keep} —`, err);
      }
    }
    let removed = 0;
    for (const pm of copies) {
      if (stuck.has(pm)) continue;
      try {
        await stripe.paymentMethods.detach(pm);
        removed++;
      } catch (err) {
        console.error(`[cards] ${event.id}: could not remove copy ${pm} —`, err);
      }
    }
    if (removed) console.log(`[cards] ${customer}: removed ${removed} saved copy(ies) of ${keep}`);
  } catch (err) {
    console.error(`[cards] ${event.id}: saved-card cleanup skipped —`, err);
  }
}
