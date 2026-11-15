/**
 * customer_subscription_plan.md phase 2: the Coalition reuses the customer's Stripe customer,
 * reports each node's subscription item, credits each item on a renewal, and copies the
 * rental's facts onto the item. Every new field is optional, so an event without items keeps
 * its old shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { handleCheckout, handleWebhook, invoiceItemLines, isMissingCustomer, normalizeEvent } from "./payments.js";
import type { StripeEvent, StripeLike } from "./stripe.js";

const SLUG = "moltentech-test1";
const req = (customer: Record<string, unknown>) =>
  ({
    schemaVersion: 1,
    providerSlug: SLUG,
    tier: "cumulus",
    customer: { mtCustomerId: "cust_1", email: "renter@example.com", ...customer },
    idempotencyKey: "k1",
    successUrl: "https://hub.test/ok",
    cancelUrl: "https://hub.test/no",
  }) as any;
const cfg = { providerSlug: SLUG, tierPrices: { cumulus: 700 }, trialDays: 1 };

function checkoutStripe(failOnCustomer?: Error) {
  const sessions: Record<string, any>[] = [];
  const stripe = {
    prices: { list: async () => ({ data: [{ id: "price_1" }] }) },
    checkout: {
      sessions: {
        create: async (args: Record<string, any>) => {
          sessions.push(args);
          if (failOnCustomer && args.customer) throw failOnCustomer;
          return { url: "https://checkout.stripe.test/s/1" };
        },
      },
    },
  } as unknown as StripeLike;
  return { stripe, sessions };
}

test("checkout reuses a known Stripe customer instead of the email", async () => {
  const { stripe, sessions } = checkoutStripe();
  await handleCheckout(stripe, cfg as any, req({ stripeCustomerId: "cus_ABC123" }));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.customer, "cus_ABC123");
  assert.equal(sessions[0]?.customer_email, undefined, "Stripe refuses customer + customer_email together");
});

test("checkout without a known customer is unchanged (email)", async () => {
  const { stripe, sessions } = checkoutStripe();
  await handleCheckout(stripe, cfg as any, req({}));
  assert.equal(sessions[0]?.customer_email, "renter@example.com");
  assert.equal(sessions[0]?.customer, undefined);
});

test("a customer Stripe no longer knows falls back to a new one from the email", async () => {
  const gone = Object.assign(new Error("No such customer: 'cus_GONE1'"), { code: "resource_missing", param: "customer" });
  const { stripe, sessions } = checkoutStripe(gone);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const res = await handleCheckout(stripe, cfg as any, req({ stripeCustomerId: "cus_GONE1" }));
    assert.equal(res.checkoutUrl, "https://checkout.stripe.test/s/1");
  } finally {
    console.warn = warn;
  }
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1]?.customer_email, "renter@example.com");
});

test("any other Stripe error on a known customer still fails the checkout", async () => {
  const { stripe } = checkoutStripe(Object.assign(new Error("card_declined"), { code: "card_declined" }));
  await assert.rejects(handleCheckout(stripe, cfg as any, req({ stripeCustomerId: "cus_ABC123" })), /card_declined/);
});

test("isMissingCustomer: only Stripe's missing-customer answer", () => {
  assert.equal(isMissingCustomer({ code: "resource_missing", param: "customer", message: "No such customer" }), true);
  assert.equal(isMissingCustomer({ raw: { code: "resource_missing", param: "customer" } }), true);
  assert.equal(isMissingCustomer({ code: "resource_missing", param: "price", message: "No such price" }), false);
  assert.equal(isMissingCustomer(new Error("network")), false);
});

const createdEvent = (item: Record<string, unknown>, metadata: Record<string, string> = {}): StripeEvent =>
  ({
    id: "evt_created",
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        metadata: { mtCustomerId: "cust_1", providerSlug: SLUG, tier: "cumulus", email: "renter@example.com", ...metadata },
        items: { data: [{ price: { unit_amount: 700 }, current_period_start: 1787604719, current_period_end: 1790283119, ...item }] },
      },
    },
  }) as unknown as StripeEvent;

test("subscription.created carries the node's item id", () => {
  const ev = normalizeEvent(createdEvent({ id: "si_A" }), SLUG) as Record<string, unknown>;
  assert.equal(ev.stripeSubscriptionItemId, "si_A");
});

test("subscription.created without an item id keeps the old shape", () => {
  const ev = normalizeEvent(createdEvent({}), SLUG) as Record<string, unknown>;
  assert.equal("stripeSubscriptionItemId" in ev, false);
});

const iso = (s?: number) => (s ? new Date(s * 1000).toISOString() : undefined);
const line = (si: string | null, amount: number, start: number, end: number, legacy = false) =>
  legacy
    ? { subscription_item: si, amount, period: { start, end } }
    : { amount, period: { start, end }, parent: si ? { subscription_item_details: { subscription_item: si } } : null };

test("renewal lines: one entry per item, amount and period", () => {
  const out = invoiceItemLines({ lines: { data: [line("si_A", 700, 100, 200), line("si_B", 350, 100, 200)] } }, iso);
  assert.deepEqual(out.lines, [
    { stripeSubscriptionItemId: "si_A", amountCents: 700, periodStart: iso(100), periodEnd: iso(200) },
    { stripeSubscriptionItemId: "si_B", amountCents: 350, periodStart: iso(100), periodEnd: iso(200) },
  ]);
});

test("renewal lines: several lines for one item are summed and the period spans them", () => {
  const out = invoiceItemLines({ lines: { data: [line("si_A", -120, 50, 100), line("si_A", 700, 100, 200)] } }, iso);
  assert.deepEqual(out.lines, [{ stripeSubscriptionItemId: "si_A", amountCents: 580, periodStart: iso(50), periodEnd: iso(200) }]);
});

test("renewal lines: the pre-2026 root `subscription_item` is read too; lines with no item are skipped", () => {
  const out = invoiceItemLines({ lines: { data: [line("si_A", 700, 100, 200, true), line(null, 999, 100, 200)] } }, iso);
  assert.deepEqual(out.lines?.map((l) => l.stripeSubscriptionItemId), ["si_A"]);
});

test("renewal with no item lines → no `lines` field (old shape)", () => {
  assert.deepEqual(invoiceItemLines({ lines: { data: [] } }, iso), {});
  assert.deepEqual(invoiceItemLines({}, iso), {});
});

test("invoice.payment_succeeded relays the lines beside the total", () => {
  const ev = normalizeEvent(
    {
      id: "evt_inv",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          billing_reason: "subscription_cycle",
          amount_paid: 1050,
          parent: { subscription_details: { subscription: "sub_1" } },
          lines: { data: [line("si_A", 700, 100, 200), line("si_B", 350, 100, 200)] },
        },
      },
    } as unknown as StripeEvent,
    SLUG
  ) as Record<string, any>;
  assert.equal(ev.amountPaidCents, 1050);
  assert.equal(ev.lines.length, 2);
});

// ── item metadata (G3) ──
const SIGNING_KEY = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
const hookCfg = { mtBaseUrl: "https://mt.test", providerSlug: SLUG, coalitionSigningKey: SIGNING_KEY, stripeWebhookSecret: "whsec_x" };
const mtAccepts = (async () =>
  new Response(JSON.stringify({ ok: true, accepted: true, rentalCode: "MT-0100" }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

function hookStripe(event: StripeEvent) {
  const itemUpdates: [string, Record<string, unknown>][] = [];
  const stripe = {
    webhooks: { constructEvent: () => event },
    subscriptions: { update: async () => ({}) },
    subscriptionItems: {
      update: async (id: string, args: Record<string, unknown>) => {
        itemUpdates.push([id, args]);
        return {};
      },
    },
  } as unknown as StripeLike;
  return { stripe, itemUpdates };
}

test("an accepted created copies rentalCode, tier and the coupon onto the item", async () => {
  const { stripe, itemUpdates } = hookStripe(createdEvent({ id: "si_A" }, { mtIntentId: "int_1", mtCoupon: "SPRING", mtCouponPct: "50" }));
  assert.equal(await handleWebhook(stripe, hookCfg as any, "{}", "sig", mtAccepts), 200);
  assert.equal(itemUpdates.length, 1);
  const [id, args] = itemUpdates[0]!;
  assert.equal(id, "si_A");
  const md = args.metadata as Record<string, string>;
  assert.equal(md.rentalCode, "MT-0100");
  assert.equal(md.tier, "cumulus");
  assert.equal(md.mtIntentId, "int_1");
  assert.equal(md.mtCoupon, "SPRING");
  assert.equal(md.mtCouponPct, "50");
});

test("an item that already carries the code is not stamped again", async () => {
  const { stripe, itemUpdates } = hookStripe(createdEvent({ id: "si_A", metadata: { rentalCode: "MT-0100" } }));
  assert.equal(await handleWebhook(stripe, hookCfg as any, "{}", "sig", mtAccepts), 200);
  assert.deepEqual(itemUpdates, []);
});
