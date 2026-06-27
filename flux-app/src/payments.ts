import {
  SCHEMA_VERSION,
  CheckoutInitRequest,
  CheckoutInitResponse,
  ManageRequest,
  ManageResponse,
  PaymentEvent,
} from "@moltentech/protocol";
import type { FluxAppConfig } from "./config";
import { ensurePrice, type StripeLike, type StripeEvent } from "./stripe";

/** Mint a subscription Checkout Session (with trial) on the operator's Stripe account. */
export async function handleCheckout(
  stripe: StripeLike,
  cfg: FluxAppConfig,
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
        stripeSubscriptionId: String(o.subscription),
        amountPaidCents: o.amount_paid ?? 0,
        currency: "usd",
        currentPeriodStart: iso(line?.start)!,
        currentPeriodEnd: iso(line?.end)!,
      } as PaymentEvent;
    }
    case "invoice.payment_failed":
      return { ...base, type: "invoice.payment_failed", stripeSubscriptionId: String(o.subscription) } as PaymentEvent;
    case "customer.subscription.deleted":
      return { ...base, type: "subscription.cancelled", stripeSubscriptionId: o.id } as PaymentEvent;
    case "charge.refunded":
      return {
        ...base,
        type: "charge.refunded",
        stripeSubscriptionId: o.subscription ? String(o.subscription) : undefined,
        stripeCustomerId: String(o.customer),
        amountRefundedCents: o.amount_refunded ?? 0,
      } as PaymentEvent;
    default:
      return null;
  }
}

/** Relay a normalized PaymentEvent outbound to MT. Returns true iff MT accepted. */
export async function relayPaymentEvent(
  cfg: Pick<FluxAppConfig, "mtBaseUrl" | "agentKey">,
  ev: PaymentEvent,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const res = await fetchImpl(`${cfg.mtBaseUrl}/api/agent/payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.agentKey}` },
    body: JSON.stringify(ev),
  });
  return res.ok;
}

/**
 * Verify + handle a Stripe webhook. Returns the HTTP status to send Stripe:
 * 200 = acked (handled or ignored); 400 = bad signature; 502 = relay to MT failed,
 * so Stripe re-delivers (its retry IS the durable queue — the Flux App stays stateless).
 */
export async function handleWebhook(
  stripe: StripeLike,
  cfg: FluxAppConfig,
  rawBody: string | Buffer,
  signature: string,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  let event: StripeEvent;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, cfg.stripeWebhookSecret);
  } catch {
    return 400;
  }
  const ev = normalizeEvent(event, cfg.providerSlug);
  if (!ev) return 200; // nothing to relay
  if (!PaymentEvent.safeParse(ev).success) return 200; // malformed mapping — don't loop Stripe
  const ok = await relayPaymentEvent(cfg, ev, fetchImpl);
  return ok ? 200 : 502;
}
