import {
  SCHEMA_VERSION,
  CheckoutInitRequest,
  CheckoutInitResponse,
  ManageRequest,
  ManageResponse,
  PaymentEvent,
} from "@moltentech/protocol";
import type { CoalitionConfig } from "./config";
import { mtAuthHeaders, type MtCallerConfig } from "./coalition-signing";
import { ensurePrice, type StripeLike, type StripeEvent } from "./stripe";

/** Mint a subscription Checkout Session (with trial) on the operator's Stripe account. */
export async function handleCheckout(
  stripe: StripeLike,
  cfg: CoalitionConfig,
  req: CheckoutInitRequest
): Promise<CheckoutInitResponse> {
  const priceCents = cfg.tierPrices[req.tier];
  if (!priceCents) throw new Error(`No price configured for tier ${req.tier}`);

  const priceId = await ensurePrice(stripe, cfg.providerSlug, req.tier, priceCents);
  const metadata = {
    mtCustomerId: req.customer.mtCustomerId,
    providerSlug: cfg.providerSlug,
    tier: req.tier,
    email: req.customer.email,
  };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: req.customer.email,
    payment_method_collection: "always",
    subscription_data: { trial_period_days: cfg.trialDays, metadata },
    metadata,
    success_url: req.successUrl,
    cancel_url: req.cancelUrl,
  });
  if (!session.url) throw new Error("Stripe returned no checkout URL");

  return {
    schemaVersion: SCHEMA_VERSION,
    checkoutUrl: session.url,
    priceCents,
    currency: "usd",
    trialDays: cfg.trialDays,
  };
}

/** Open the operator-account billing portal, or cancel a subscription. */
export async function handleManage(
  stripe: StripeLike,
  req: ManageRequest
): Promise<ManageResponse> {
  if (req.action === "cancel") {
    await stripe.subscriptions.cancel(req.stripeSubscriptionId);
    return { schemaVersion: SCHEMA_VERSION, ok: true };
  }
  const sub = await stripe.subscriptions.retrieve(req.stripeSubscriptionId);
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const portal = await stripe.billingPortal.sessions.create({
    customer,
    return_url: req.returnUrl,
  });
  return { schemaVersion: SCHEMA_VERSION, ok: true, portalUrl: portal.url };
}

/**
 * The subscription id behind an invoice.
 *
 * ⚠️ **`invoice.subscription` does not exist in the API version these webhooks arrive in.**
 * Stripe moved it to `parent.subscription_details.subscription` in the same 2026 revision that
 * moved `current_period_*` off the subscription root onto the line item — the migration
 * `normalizeEvent` already compensates for a few lines below. Reading the removed root field
 * yielded the *string* `"undefined"`, which is 7 characters long and therefore sails through
 * `z.string().min(1)`; MT then looked up a subscription by that name, found nothing, and
 * answered `200 {accepted:false, reason:"unknown_subscription"}`. The relay saw `res.ok`,
 * acked Stripe, and the event was gone.
 *
 * Measured cost: MT-0075's 2026-08-24 renewal (`sub_1U7iN1…Zr1P`, $7.00, 08-24 → 09-24) never
 * reached the hub. It was the first renewal the platform ever had, so this had never fired.
 *
 * Root first so an older API version still works, then the two places the id actually lives.
 * Returns `undefined` rather than a placeholder when nothing resolves: the schema requires a
 * non-empty id on the invoice events, so an unresolvable one fails validation loudly instead
 * of being relayed as a name that matches nothing.
 */
function invoiceSubscriptionId(o: Record<string, any>): string | undefined {
  const idOf = (v: unknown): string | undefined =>
    typeof v === "string" ? v : typeof v === "object" && v !== null ? (v as any).id : undefined;
  const line0 = (o.lines?.data?.[0] ?? {}) as Record<string, any>;
  return (
    idOf(o.subscription) ??
    idOf(o.parent?.subscription_details?.subscription) ??
    idOf(line0.parent?.subscription_item_details?.subscription)
  );
}

/** Map a Stripe event to a normalized PaymentEvent, or null to ignore. */
export function normalizeEvent(event: StripeEvent, providerSlug: string): PaymentEvent | null {
  const o = event.data.object as Record<string, any>;
  const base = { schemaVersion: SCHEMA_VERSION, providerSlug, stripeEventId: event.id, occurredAt: new Date().toISOString() };
  const iso = (s?: number) => (s ? new Date(s * 1000).toISOString() : undefined);

  switch (event.type) {
    case "customer.subscription.created": {
      const md = (o.metadata ?? {}) as Record<string, string>;
      // Stripe API 2026-01-28+ moved current_period_* off the subscription root onto
      // the line item; read item first, fall back to root for older API versions.
      const item0 = (o.items?.data?.[0] ?? {}) as Record<string, any>;
      return {
        ...base,
        type: "subscription.created",
        stripeSubscriptionId: o.id,
        stripeCustomerId: String(o.customer),
        mtCustomerId: md.mtCustomerId ?? "",
        email: md.email ?? "",
        tier: md.tier as PaymentEvent extends { tier: infer T } ? T : never,
        priceCents: item0.price?.unit_amount ?? 0,
        currency: "usd",
        trialEndsAt: iso(o.trial_end),
        currentPeriodStart: iso(item0.current_period_start ?? o.current_period_start)!,
        currentPeriodEnd: iso(item0.current_period_end ?? o.current_period_end)!,
      } as PaymentEvent;
    }
    case "invoice.payment_succeeded": {
      if (o.billing_reason === "subscription_create") return null; // first/$0 trial invoice — created handles it
      const line = o.lines?.data?.[0]?.period;
      return {
        ...base,
        type: "invoice.payment_succeeded",
        stripeSubscriptionId: invoiceSubscriptionId(o)!,
        amountPaidCents: o.amount_paid ?? 0,
        currency: "usd",
        currentPeriodStart: iso(line?.start)!,
        currentPeriodEnd: iso(line?.end)!,
      } as PaymentEvent;
    }
    case "invoice.payment_failed":
      // Same removed field, and this is the branch that costs money when it is dropped.
      return { ...base, type: "invoice.payment_failed", stripeSubscriptionId: invoiceSubscriptionId(o)! } as PaymentEvent;
    case "customer.subscription.deleted":
      return { ...base, type: "subscription.cancelled", stripeSubscriptionId: o.id } as PaymentEvent;
    case "charge.refunded":
      // ⚠️ KNOWN GAP, not an oversight: a Charge object carries no subscription pointer at all
      // (it has `invoice`, not `subscription`), so this is undefined in practice and MT answers
      // `no_subscription_ref` — the customer's refund alert and email never go out. Closing it
      // needs an `invoices.retrieve` round-trip on the operator's key, which is a bigger change
      // than this fix; the schema already makes the field optional for exactly this event.
      return {
        ...base,
        type: "charge.refunded",
        stripeSubscriptionId: invoiceSubscriptionId(o),
        stripeCustomerId: String(o.customer),
        amountRefundedCents: o.amount_refunded ?? 0,
      } as PaymentEvent;
    default:
      return null;
  }
}

export type RelayResult = {
  /** Transport-level: MT answered 2xx. A 5xx or a thrown fetch is `false`. */
  delivered: boolean;
  /** MT's own verdict. `false` means it took the request but did NOT act on it. */
  accepted: boolean;
  /** MT's machine-readable reason when it refused, e.g. `unknown_subscription`. */
  reason?: string;
  /** The documented terminal-rejection directive, e.g. `cancel`. */
  directive?: string;
};

/**
 * Relay a normalized PaymentEvent outbound to MT.
 *
 * ⚠️ This used to `return res.ok`, which made MT's `{accepted:false}` — its way of saying "I
 * received this and deliberately did nothing" — indistinguishable from success. That is how a
 * paid renewal disappeared without a single error on either side. The verdict now comes back
 * to the caller intact; `handleWebhook` decides what to tell Stripe.
 */
export async function relayPaymentEvent(
  cfg: Pick<CoalitionConfig, "mtBaseUrl"> & MtCallerConfig,
  ev: PaymentEvent,
  fetchImpl: typeof fetch = fetch
): Promise<RelayResult> {
  // One serialization, signed and sent — see the lifecycle relay for why.
  const rawBody = JSON.stringify(ev);
  const res = await fetchImpl(`${cfg.mtBaseUrl}/api/agent/payment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...mtAuthHeaders(cfg, "POST", "/api/agent/payment", rawBody),
    },
    body: rawBody,
  });
  if (!res.ok) return { delivered: false, accepted: false };

  // A 2xx with an unreadable body is treated as accepted: MT's contract is that it only answers
  // 2xx once it has processed the event, and inventing a failure here would re-deliver work it
  // has already done.
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    return { delivered: true, accepted: true };
  }
  return {
    delivered: true,
    accepted: body?.accepted !== false,
    reason: typeof body?.reason === "string" ? body.reason : undefined,
    directive: typeof body?.directive === "string" ? body.directive : undefined,
  };
}

/**
 * Refusals that are a correct, terminal answer rather than a fault — ack Stripe and move on.
 *
 * `no_subscription_ref` is MT's response to a refund it cannot map to a subscription, and its
 * own comment says "record nothing but ack so it isn't retried". Anything NOT on this list is
 * treated as a fault, because the alternative is the silence this whole change exists to end.
 */
const BENIGN_REFUSALS = new Set(["no_subscription_ref"]);

/**
 * Verify + handle a Stripe webhook. Returns the HTTP status to send Stripe:
 * 200 = acked (handled or ignored); 400 = bad signature; 502 = relay to MT failed,
 * so Stripe re-delivers (its retry IS the durable queue — the Coalition stays stateless).
 */
export async function handleWebhook(
  stripe: StripeLike,
  cfg: CoalitionConfig,
  rawBody: string | Buffer,
  signature: string,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  // No webhook secret means no way to authenticate the caller. Refusing is the only
  // safe answer: verifying against a placeholder would accept forged events. The
  // route above already 503s when Stripe is disabled entirely, so this is the
  // narrower case of a key present but a secret missing.
  if (!cfg.stripeWebhookSecret) return 503;

  let event: StripeEvent;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, cfg.stripeWebhookSecret);
  } catch {
    return 400;
  }
  const ev = normalizeEvent(event, cfg.providerSlug);
  if (!ev) return 200; // nothing to relay

  // A mapping that fails its own schema is a bug in THIS file, and the last one cost a paid
  // renewal. It used to ack (200) on the reasoning that re-delivery cannot fix a code defect —
  // true, but it also meant nothing anywhere recorded the loss. A 502 puts it in Stripe's
  // dashboard as a failing delivery, which is the only alarm this stateless service has.
  const parsed = PaymentEvent.safeParse(ev);
  if (!parsed.success) {
    console.error(
      `[payments] ${event.type} ${event.id}: mapping failed validation, NOT relayed —`,
      JSON.stringify(parsed.error.flatten().fieldErrors)
    );
    return 502;
  }

  const result = await relayPaymentEvent(cfg, ev, fetchImpl);
  if (!result.delivered) return 502; // transient — Stripe's retry is the durable queue
  if (result.accepted) return 200;

  // MT took the request and declined to act on it.
  if (result.directive === "cancel") {
    // The documented terminal rejection: MT wants the (trialing) subscription cancelled.
    // ⚠️ The cancellation itself is NOT implemented here — acking a directive we do not carry
    // out is the honest current behaviour, and it is logged so it cannot pass unnoticed.
    console.error(
      `[payments] ${event.type} ${event.id}: MT directed cancel (${result.reason ?? "no reason"}) — NOT IMPLEMENTED, acked anyway`
    );
    return 200;
  }
  if (result.reason && BENIGN_REFUSALS.has(result.reason)) {
    console.warn(`[payments] ${event.type} ${event.id}: MT declined (${result.reason}) — expected, acked`);
    return 200;
  }
  console.error(
    `[payments] ${event.type} ${event.id}: MT REFUSED (${result.reason ?? "no reason given"}) — not acked, Stripe will re-deliver`
  );
  return 502;
}
