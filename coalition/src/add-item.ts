import { SCHEMA_VERSION, type AddItemRequest, type AddItemResponse, type PaymentEvent } from "@moltentech/protocol";
import type { CoalitionConfig } from "./config";
import type { MtCallerConfig } from "./coalition-signing";
import { ensureTierPrice, type StripeLike } from "./stripe";
import { couponPriceCents, verifyCoupon, MD } from "./coupon";
import { relayPaymentEvent, type RelayResult } from "./payments";

/** Stripe allows at most 100 items on one subscription (tested 11-12). */
export const MAX_ITEMS = 100;

type Relay = (cfg: Pick<CoalitionConfig, "mtBaseUrl"> & MtCallerConfig, ev: PaymentEvent) => Promise<RelayResult>;

const iso = (s?: number) => (s ? new Date(s * 1000).toISOString() : undefined);
const no = (reason: AddItemResponse["reason"], message: string, extra: Partial<AddItemResponse> = {}): AddItemResponse => ({
  schemaVersion: SCHEMA_VERSION,
  added: false,
  reason,
  message,
  ...extra,
});

/** A Stripe error from charging the saved card: declined, or it needs the customer (3-D Secure). */
export function cardRefusal(err: unknown): "card_failed" | "action_required" | null {
  const e = err as { type?: string; code?: string; message?: string; raw?: { code?: string; type?: string } };
  const code = e?.code ?? e?.raw?.code ?? "";
  if (/requires_action|authentication_required/.test(code) || /requires_action|authenticat/i.test(e?.message ?? "")) {
    return "action_required";
  }
  if (
    e?.type === "StripeCardError" ||
    e?.raw?.type === "card_error" ||
    /card_declined|expired_card|insufficient_funds|incorrect_cvc|payment_intent_payment_attempt_failed/.test(code)
  ) {
    return "card_failed";
  }
  return null;
}

/**
 * `POST /add-item` — one more node on a bill the customer already has (customer_subscription_plan.md
 * phase 3, D7/D10/D11/D12).
 *
 * Checks, then charges, then lets MT mint the rental:
 * 1. the subscription is this customer's (Stripe customer AND the `mtCustomerId` it was opened
 *    for), `active` (not trialing, past due or cancelled), under 100 items, and has no bill-wide
 *    discount (it would discount the new node too — tested 11-12);
 * 2. the item is created at the node's price (`price_data` on the tier's product: one price object
 *    cannot sit on two items of a subscription), the rest of the period charged now on the saved
 *    card (`always_invoice` + `error_if_incomplete`: a declined card or 3-D Secure fails the call
 *    and nothing is added);
 * 3. `subscription.item_added` goes through the normal relay, so MT's intent match, slot, config
 *    and sold-out checks are the ones every rental passes (D11). MT refusing now means money moved
 *    for a node it will not deliver (D12): the item is removed and the answer says `refused` with
 *    the amount, so the hub tells the operator to refund it.
 */
export async function handleAddItem(
  stripe: StripeLike,
  cfg: CoalitionConfig,
  req: AddItemRequest,
  relay: Relay = relayPaymentEvent
): Promise<AddItemResponse> {
  const tierCents = cfg.tierPrices[req.tier];
  if (!tierCents) throw new Error(`No price configured for tier ${req.tier}`);
  const { productId } = await ensureTierPrice(stripe, cfg.providerSlug, req.tier, tierCents);
  if (!productId) throw new Error("the tier price has no product");

  let coupon: { name: string; pct: number; chargedCents: number } | null = null;
  if (req.coupon) {
    const v = verifyCoupon(cfg, req.tier, req.coupon);
    if (!v.ok) throw new Error(`coupon refused: ${v.reason}`);
    coupon = { name: v.terms.name, pct: v.terms.discountPct, chargedCents: couponPriceCents(tierCents, v.terms.discountPct) };
  }
  const priceCents = coupon ? coupon.chargedCents : tierCents;

  // 1. Is this bill one the customer may add to?
  const sub = (await stripe.subscriptions.retrieve(req.stripeSubscriptionId)) as Record<string, any>;
  const subCustomer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  const md = (sub.metadata ?? {}) as Record<string, string>;
  if (subCustomer !== req.customer.stripeCustomerId || md.mtCustomerId !== req.customer.mtCustomerId) {
    return no("not_eligible", "That bill isn't yours.");
  }
  if (sub.status !== "active") return no("not_eligible", "That bill can't take another node right now. Use a separate bill.");
  if ((Array.isArray(sub.discounts) && sub.discounts.length > 0) || sub.discount) {
    return no("not_eligible", "That bill has a discount that would apply to every node on it. Use a separate bill.");
  }
  const items = await stripe.subscriptionItems.list({ subscription: req.stripeSubscriptionId, limit: MAX_ITEMS });
  if (items.data.length >= MAX_ITEMS) return no("not_eligible", "That bill already has 100 nodes. Use a separate bill.");

  // 2. Add the node and charge the rest of this period.
  const itemMd: Record<string, string> = {
    mtCustomerId: req.customer.mtCustomerId,
    mtIntentId: req.customer.mtIntentId,
    tier: req.tier,
    ...(coupon ? { [MD.name]: coupon.name, [MD.pct]: String(coupon.pct) } : {}),
  };
  let item: Record<string, any>;
  try {
    item = await stripe.subscriptionItems.create(
      {
        subscription: req.stripeSubscriptionId,
        price_data: { currency: "usd", product: productId, unit_amount: priceCents, recurring: { interval: "month" } },
        quantity: 1,
        metadata: itemMd,
        proration_behavior: "always_invoice",
        payment_behavior: "error_if_incomplete",
      },
      { idempotencyKey: `add-item:${req.idempotencyKey}` }
    );
  } catch (err) {
    const why = cardRefusal(err);
    if (why === "card_failed") return no(why, "Your saved card was declined, so nothing was added. Use a separate bill to pay with another card.");
    if (why === "action_required") return no(why, "Your bank wants to confirm this payment, which needs the Stripe page. Use a separate bill.");
    throw err;
  }

  const after = (await stripe.subscriptions.retrieve(req.stripeSubscriptionId, { expand: ["latest_invoice"] })) as Record<string, any>;
  const inv = after.latest_invoice as Record<string, any> | null;
  const chargedCents = typeof inv?.amount_paid === "number" ? inv.amount_paid : 0;
  const periodStart = iso(item.current_period_start ?? after.current_period_start)!;
  const periodEnd = iso(item.current_period_end ?? after.current_period_end)!;

  // 3. MT mints the rental the way it mints every rental.
  const ev = {
    schemaVersion: SCHEMA_VERSION,
    type: "subscription.item_added",
    providerSlug: cfg.providerSlug,
    stripeEventId: `mt_add_item_${item.id}`,
    occurredAt: new Date().toISOString(),
    stripeSubscriptionId: req.stripeSubscriptionId,
    stripeSubscriptionItemId: String(item.id),
    stripeCustomerId: req.customer.stripeCustomerId,
    mtCustomerId: req.customer.mtCustomerId,
    mtIntentId: req.customer.mtIntentId,
    email: req.customer.email,
    tier: req.tier,
    priceCents,
    amountPaidCents: chargedCents,
    currency: "usd",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  } as PaymentEvent;

  let result: RelayResult = { delivered: false, accepted: false };
  for (let attempt = 0; attempt < 3 && !result.delivered; attempt++) {
    result = await relay(cfg, ev).catch(() => ({ delivered: false, accepted: false }) as RelayResult);
  }
  if (!result.accepted || !result.rentalCode) {
    // D12: charged, but no rental. Take the node off the bill (no proration: nothing is credited
    // automatically) and say so, so the hub asks the operator to refund `chargedCents`.
    await stripe.subscriptionItems
      .del(String(item.id), { proration_behavior: "none" })
      .catch((e: Error) => console.error(`[add-item] could not remove ${item.id} after a refusal: ${e.message}`));
    console.error(`[add-item] ${req.stripeSubscriptionId}: MT did not take the node (${result.reason ?? (result.delivered ? "refused" : "unreachable")}) — ${chargedCents}¢ charged, refund by hand`);
    return no("refused", "The node couldn't be set up, so it was taken off your bill. The operator will refund what was charged.", {
      chargedCents,
      stripeSubscriptionItemId: String(item.id),
    });
  }

  await stripe.subscriptionItems
    .update(String(item.id), { metadata: { rentalCode: result.rentalCode } })
    .catch((e: Error) => console.error(`[add-item] could not stamp ${result.rentalCode} on ${item.id}: ${e.message}`));
  console.log(`[add-item] ${req.stripeSubscriptionId}: + ${item.id} ${result.rentalCode} (${chargedCents}¢ now, ${priceCents}¢/month)`);
  return {
    schemaVersion: SCHEMA_VERSION,
    added: true,
    stripeSubscriptionItemId: String(item.id),
    rentalCode: result.rentalCode,
    chargedCents,
    priceCents,
    currentPeriodEnd: periodEnd,
  };
}
