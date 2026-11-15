/**
 * customer_subscription_plan.md phase 3b: end ONE node on a shared bill (`cancel_item`), the
 * card + invoices billing portal (G2), and lines added/removed outside the hub relayed as
 * `subscription.items_changed`.
 */
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { ManageRequest, PaymentEvent } from "@moltentech/protocol";
import { handleManage, handleWebhook, itemsChangedEvent, portalConfiguration, resetPortalConfigCache, PORTAL_TAG } from "./payments.js";
import type { StripeEvent, StripeLike } from "./stripe.js";

const SLUG = "moltentech-test1";

function fake(opts: { items?: string[]; status?: string; elsewhere?: string; configs?: { id: string; metadata?: unknown }[]; configError?: Error } = {}) {
  const calls = { deleted: [] as [string, any][], cancelled: [] as string[], created: [] as any[], sessions: [] as any[] };
  const stripe = {
    subscriptions: {
      retrieve: async () => ({ id: "sub_1", customer: "cus_1", status: opts.status ?? "active" }),
      cancel: async (id: string) => void calls.cancelled.push(id),
    },
    subscriptionItems: {
      list: async () => ({ data: (opts.items ?? ["si_a", "si_b"]).map((id) => ({ id })) }),
      del: async (id: string, args: unknown) => void calls.deleted.push([id, args]),
      retrieve: async (id: string) => {
        if (!opts.elsewhere) throw Object.assign(new Error(`No such subscription item: '${id}'`), { code: "resource_missing" });
        return { id, subscription: opts.elsewhere };
      },
    },
    billingPortal: {
      sessions: { create: async (args: any) => (calls.sessions.push(args), { url: "https://billing.stripe.com/p/session/x" }) },
      configurations: {
        list: async () => {
          if (opts.configError) throw opts.configError;
          return { data: opts.configs ?? [] };
        },
        create: async (args: any) => (calls.created.push(args), { id: "bpc_new" }),
      },
    },
  } as unknown as StripeLike;
  return { stripe, calls };
}
const cancelItem = (si = "si_b") =>
  ({ schemaVersion: 2, providerSlug: SLUG, action: "cancel_item", stripeSubscriptionId: "sub_1", stripeSubscriptionItemId: si }) as any;

test("protocol: cancel_item needs the item id", () => {
  const base = { schemaVersion: 2, providerSlug: SLUG, action: "cancel_item", stripeSubscriptionId: "sub_1" };
  assert.equal(ManageRequest.safeParse(base).success, false);
  assert.equal(ManageRequest.safeParse({ ...base, stripeSubscriptionItemId: "si_b" }).success, true);
  assert.equal(ManageRequest.safeParse({ ...base, action: "cancel" }).success, true);
});

test("cancel_item on a shared bill removes only that line, no proration (D3)", async () => {
  const { stripe, calls } = fake();
  const res = await handleManage(stripe, cancelItem());
  assert.deepEqual(calls.deleted, [["si_b", { proration_behavior: "none" }]]);
  assert.deepEqual(calls.cancelled, []);
  assert.equal(res.ok, true);
  assert.equal(res.subscriptionCancelled, false);
});

test("cancel_item on the bill's only node cancels the subscription (Stripe refuses the last item)", async () => {
  const { stripe, calls } = fake({ items: ["si_b"] });
  const res = await handleManage(stripe, cancelItem());
  assert.deepEqual(calls.cancelled, ["sub_1"]);
  assert.deepEqual(calls.deleted, []);
  assert.equal(res.subscriptionCancelled, true);
});

test("cancel_item is idempotent: a line already gone answers ok", async () => {
  const { stripe, calls } = fake({ items: ["si_a"] });
  const res = await handleManage(stripe, cancelItem("si_b"));
  assert.equal(res.ok, true);
  assert.equal(res.subscriptionCancelled, false);
  assert.deepEqual(calls.deleted, []);
  assert.deepEqual(calls.cancelled, []);
});

test("cancel_item on an already-cancelled subscription answers ok", async () => {
  const { stripe, calls } = fake({ status: "canceled" });
  const res = await handleManage(stripe, cancelItem());
  assert.equal(res.subscriptionCancelled, true);
  assert.deepEqual(calls.cancelled, []);
});

test("cancel_item refuses a line that sits on ANOTHER subscription", async () => {
  const { stripe, calls } = fake({ items: ["si_a"], elsewhere: "sub_9" });
  await assert.rejects(handleManage(stripe, cancelItem("si_b")), /on sub_9, not sub_1/);
  assert.deepEqual(calls.deleted, []);
});

test("portal: made once with card + invoices only, then reused", async () => {
  resetPortalConfigCache();
  const { stripe, calls } = fake();
  await handleManage(stripe, { schemaVersion: 2, providerSlug: SLUG, action: "open_portal", stripeSubscriptionId: "sub_1" } as any);
  assert.equal(calls.created.length, 1);
  const f = calls.created[0].features;
  assert.equal(f.subscription_cancel.enabled, false);
  assert.equal(f.subscription_update.enabled, false);
  assert.equal(f.payment_method_update.enabled, true);
  assert.equal(f.invoice_history.enabled, true);
  assert.equal(calls.created[0].metadata.mtPortal, PORTAL_TAG);
  assert.ok(calls.created[0].business_profile.headline.length <= 60, "Stripe caps the headline at 60");
  assert.equal(calls.sessions[0].configuration, "bpc_new");
  await portalConfiguration(stripe);
  assert.equal(calls.created.length, 1, "cached");
});

test("portal: an existing tagged configuration is found, not re-made", async () => {
  resetPortalConfigCache();
  const { stripe, calls } = fake({ configs: [{ id: "bpc_default", metadata: {} }, { id: "bpc_ours", metadata: { mtPortal: PORTAL_TAG } }] });
  assert.equal(await portalConfiguration(stripe), "bpc_ours");
  assert.equal(calls.created.length, 0);
});

test("portal: a Stripe error falls back to the account default, never fails the request", async () => {
  resetPortalConfigCache();
  const { stripe, calls } = fake({ configError: new Error("permission denied") });
  const res = await handleManage(stripe, { schemaVersion: 2, providerSlug: SLUG, action: "open_portal", stripeSubscriptionId: "sub_1" } as any);
  assert.equal(res.portalUrl, "https://billing.stripe.com/p/session/x");
  assert.equal(calls.sessions[0].configuration, undefined);
  resetPortalConfigCache();
});

const updated = (before: Record<string, any>[], now: Record<string, any>[], extraPrev: Record<string, unknown> = {}) =>
  ({
    id: "evt_1",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_1", items: { data: now } }, previous_attributes: { items: { data: before }, ...extraPrev } },
  }) as unknown as StripeEvent;

test("items_changed: a line removed in the Dashboard carries its old period end", () => {
  // The shape Stripe sent on 11-15 (evt_1Uc9ED…): prev keys items, plan, quantity.
  const ev = itemsChangedEvent(updated([{ id: "si_a", current_period_end: 1797363390 }, { id: "si_b", current_period_end: 1797363390 }], [{ id: "si_a" }]), SLUG);
  assert.ok(ev && ev.type === "subscription.items_changed");
  assert.deepEqual(ev.removed, [{ stripeSubscriptionItemId: "si_b", periodEnd: new Date(1797363390 * 1000).toISOString() }]);
  assert.deepEqual(ev.added, []);
  assert.equal(ev.stripeEventId, "evt_1:items");
  assert.equal(PaymentEvent.safeParse(ev).success, true);
});

test("items_changed: a line added by hand is reported; one /add-item made is not", () => {
  const ev = itemsChangedEvent(
    updated([{ id: "si_a" }], [{ id: "si_a" }, { id: "si_hand", price: { unit_amount: 900 } }, { id: "si_add", metadata: { mtIntentId: "int_1" } }]),
    SLUG
  );
  assert.ok(ev && ev.type === "subscription.items_changed");
  assert.deepEqual(ev.added, [{ stripeSubscriptionItemId: "si_hand", amountCents: 900 }]);
  assert.deepEqual(ev.removed, []);
});

test("items_changed: a renewal (same ids, new periods) and an /add-item alone relay nothing", () => {
  assert.equal(itemsChangedEvent(updated([{ id: "si_a", current_period_end: 1 }], [{ id: "si_a", current_period_end: 2 }]), SLUG), null);
  assert.equal(itemsChangedEvent(updated([{ id: "si_a" }], [{ id: "si_a" }, { id: "si_add", metadata: { mtIntentId: "i" } }]), SLUG), null);
  const noItems = { id: "evt_2", type: "customer.subscription.updated", data: { object: { id: "sub_1" }, previous_attributes: { cancel_at_period_end: false } } } as unknown as StripeEvent;
  assert.equal(itemsChangedEvent(noItems, SLUG), null);
});

test("webhook: a line removed AND a cancel scheduled on one event relay both, lines first; a failed first relay is a 502", async () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
  const cfg = { mtBaseUrl: "https://mt.test", providerSlug: SLUG, coalitionSigningKey: key, stripeWebhookSecret: "whsec_x" };
  const event = updated([{ id: "si_a", current_period_end: 2 }, { id: "si_b", current_period_end: 2 }], [{ id: "si_a", current_period_end: 2 }], { cancel_at_period_end: false });
  (event.data.object as any).cancel_at_period_end = true;
  const stripe = { webhooks: { constructEvent: () => event } } as unknown as StripeLike;
  const sent: string[] = [];
  const mt = (status: number) =>
    (async (_u: string, init: any) => {
      sent.push(JSON.parse(init.body).type);
      return new Response(JSON.stringify({ ok: true, accepted: true }), { status, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
  assert.equal(await handleWebhook(stripe, cfg as any, "{}", "sig", mt(200)), 200);
  assert.deepEqual(sent, ["subscription.items_changed", "subscription.updated"]);
  sent.length = 0;
  assert.equal(await handleWebhook(stripe, cfg as any, "{}", "sig", mt(500)), 502);
  assert.deepEqual(sent, ["subscription.items_changed"], "the cancel waits for Stripe's re-delivery");
});
