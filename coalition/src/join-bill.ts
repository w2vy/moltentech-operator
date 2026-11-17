import { SCHEMA_VERSION, type JoinBillRequest, type JoinBillResponse } from "@moltentech/protocol";
import type { CoalitionConfig } from "./config";
import type { StripeLike } from "./stripe";
import { MAX_ITEMS, cardRefusal } from "./add-item";
import { MD } from "./coupon";
import { MOVED_TO, JOINED_FROM } from "./payments";

const iso = (s?: number) => (s ? new Date(s * 1000).toISOString() : undefined);
const no = (reason: JoinBillResponse["reason"], message: string): JoinBillResponse => ({
  schemaVersion: SCHEMA_VERSION,
  joined: false,
  reason,
  message,
});
const customerOf = (sub: Record<string, any>) => (typeof sub.customer === "string" ? sub.customer : sub.customer?.id);
const productOf = (price: Record<string, any> | undefined) =>
  typeof price?.product === "string" ? price.product : price?.product?.id;

/**
 * What the move charged: the paid proration invoice on the target bill whose line is this node's
 * new item. Read the same way on the first try and on a retry, so a retry after the line was
 * already added reports the real charge, not 0 (prod 2026-11-17: MT-0198, $4.45 charged, the
 * mail said $0.00). Needs the key's Invoices Read. A line field moved under `parent` in newer
 * Stripe API versions; both are read.
 */
async function joinChargeCents(stripe: StripeLike, subscriptionId: string, itemId: string): Promise<number> {
  const invoices = (await stripe.invoices.list({ subscription: subscriptionId, limit: 10 })).data;
  const lineItem = (l: Record<string, any>) => l.subscription_item ?? l.parent?.subscription_item_details?.subscription_item;
  const inv = invoices.find((i) => ((i.lines?.data ?? []) as Record<string, any>[]).some((l) => lineItem(l) === itemId && (l.proration ?? l.parent?.subscription_item_details?.proration)));
  return typeof inv?.amount_paid === "number" ? inv.amount_paid : 0;
}

/**
 * `POST /join-bill` — move a node that is alone on its own bill onto another of the customer's
 * bills (customer_subscription_plan.md phase 4, tom 11-17: join AT the old bill's renewal).
 *
 * MT calls it in the last hours before the old bill renews. In order:
 * 1. both bills are this customer's; the target is `active`, has no bill-wide discount and room;
 *    the old bill is `active`/`trialing`, not cancelling, and its only line is this rental;
 * 2. the line is added to the target at the price it has today (a running coupon price carries
 *    over), charged from the OLD bill's renewal to the target's (`proration_date`), on the saved
 *    card (`always_invoice` + `error_if_incomplete`: declined or 3-D Secure → nothing changes);
 * 3. the old bill is stamped `mtMovedTo` and cancelled now, no proration, no invoice. Its
 *    `subscription.deleted` is not relayed (`normalizeEvent`): the rental did not end.
 *
 * Idempotent: a line for this rental already on the target (a retry after a lost answer) skips
 * step 2 and finishes step 3; the charge is read back from the target's invoices either way.
 */
export async function handleJoinBill(stripe: StripeLike, _cfg: CoalitionConfig, req: JoinBillRequest): Promise<JoinBillResponse> {
  if (req.fromSubscriptionId === req.toSubscriptionId) return no("not_eligible", "That node is already on that bill.");
  const from = (await stripe.subscriptions.retrieve(req.fromSubscriptionId)) as Record<string, any>;
  const to = (await stripe.subscriptions.retrieve(req.toSubscriptionId)) as Record<string, any>;
  const mine = (s: Record<string, any>) =>
    customerOf(s) === req.customer.stripeCustomerId && (s.metadata ?? {}).mtCustomerId === req.customer.mtCustomerId;
  if (!mine(from) || !mine(to)) return no("not_eligible", "That bill isn't yours.");

  const toItems = (await stripe.subscriptionItems.list({ subscription: req.toSubscriptionId, limit: MAX_ITEMS })).data;
  const already = toItems.find((i) => (i.metadata ?? {}).rentalCode === req.rentalCode);

  let itemId: string;
  let chargedCents = 0;
  let priceCents: number;
  if (already) {
    itemId = String(already.id);
    priceCents = already.price?.unit_amount ?? 0;
  } else {
    // 1. May this node move?
    if (to.status !== "active") return no("not_eligible", "That bill can't take another node right now.");
    if ((Array.isArray(to.discounts) && to.discounts.length > 0) || to.discount) {
      return no("not_eligible", "That bill has a discount that would apply to every node on it.");
    }
    if (toItems.length >= MAX_ITEMS) return no("not_eligible", "That bill already has 100 nodes.");
    if (from.status !== "active" && from.status !== "trialing") return no("not_eligible", "This node's bill is not open.");
    if (from.cancel_at_period_end || from.cancel_at) return no("not_eligible", "This node's bill is set to end.");
    const fromItems = (await stripe.subscriptionItems.list({ subscription: req.fromSubscriptionId, limit: 2 })).data;
    if (fromItems.length !== 1) return no("not_eligible", "This node shares its bill with other nodes.");
    const line = fromItems[0]!;
    const lineMd = (line.metadata ?? {}) as Record<string, string>;
    const subMd = (from.metadata ?? {}) as Record<string, string>;
    if ((lineMd.rentalCode ?? subMd.rentalCode) !== req.rentalCode) return no("not_eligible", "That bill is not this node's.");
    const product = productOf(line.price);
    if (!product || typeof line.price?.unit_amount !== "number") throw new Error(`${line.id} has no price to copy`);
    priceCents = line.price.unit_amount;
    // The old bill is paid up to here; the target charges from here to its own renewal.
    const renewal = Number(line.current_period_end ?? from.current_period_end);
    if (!renewal) throw new Error(`${req.fromSubscriptionId} has no period end`);

    // 2. The line on the target bill, charged from the old renewal on.
    const md: Record<string, string> = { rentalCode: req.rentalCode, mtCustomerId: req.customer.mtCustomerId, [JOINED_FROM]: req.fromSubscriptionId };
    for (const k of ["tier", MD.name, MD.pct]) {
      const v = lineMd[k] ?? subMd[k];
      if (v) md[k] = v;
    }
    let item: Record<string, any>;
    try {
      item = await stripe.subscriptionItems.create(
        {
          subscription: req.toSubscriptionId,
          price_data: { currency: "usd", product, unit_amount: priceCents, recurring: { interval: "month" } },
          quantity: 1,
          metadata: md,
          proration_behavior: "always_invoice",
          proration_date: renewal,
          payment_behavior: "error_if_incomplete",
        },
        { idempotencyKey: `join-bill:${req.idempotencyKey ?? `${req.rentalCode}:${req.fromSubscriptionId}`}` }
      );
    } catch (err) {
      const why = cardRefusal(err);
      if (why === "card_failed") return no(why, "The saved card was declined, so the node stays on its own bill.");
      if (why === "action_required") return no(why, "The bank wants to confirm the payment, so the node stays on its own bill.");
      throw err;
    }
    itemId = String(item.id);
  }
  chargedCents = await joinChargeCents(stripe, req.toSubscriptionId, itemId);

  // 3. Close the old bill: a move, not an end.
  let oldBillCancelled = from.status === "canceled";
  if (!oldBillCancelled) {
    try {
      await stripe.subscriptions.update(req.fromSubscriptionId, { metadata: { [MOVED_TO]: req.toSubscriptionId } });
      await stripe.subscriptions.cancel(req.fromSubscriptionId, { prorate: false, invoice_now: false });
      oldBillCancelled = true;
    } catch (e) {
      console.error(`[join-bill] ${req.rentalCode}: line ${itemId} is on ${req.toSubscriptionId} but ${req.fromSubscriptionId} did not cancel — ${(e as Error).message}`);
    }
  }

  const target = (await stripe.subscriptionItems.retrieve(itemId)) as Record<string, any>;
  const periodEnd = iso(target.current_period_end ?? to.current_period_end);
  console.log(`[join-bill] ${req.rentalCode}: ${req.fromSubscriptionId} → ${req.toSubscriptionId} (${itemId}, ${chargedCents}¢ now, ${priceCents}¢/month)`);
  return {
    schemaVersion: SCHEMA_VERSION,
    joined: true,
    stripeSubscriptionItemId: itemId,
    chargedCents,
    priceCents,
    ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
    oldBillCancelled,
  };
}
