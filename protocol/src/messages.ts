import { z } from "zod";
import {
  Currency,
  Envelope,
  PriceCents,
  ProviderSlug,
  TierKey,
  Timestamp,
} from "./common";

// ───────────────────────────────────────────────────────────────────────────
// 1. checkout-init  —  MT → operator Flux App
//    MT asks the Flux App to quote the price and mint a subscription Checkout
//    Session (trial enabled) on the OPERATOR's Stripe account. Auth: MT-issued key.
// ───────────────────────────────────────────────────────────────────────────
export const CheckoutInitRequest = Envelope.extend({
  providerSlug: ProviderSlug,
  tier: TierKey,
  /** The MT customer buying — the Flux App passes email to Checkout and echoes mtCustomerId back in events. */
  customer: z.object({
    mtCustomerId: z.string().min(1),
    email: z.string().email(),
  }),
  /** Dedupe a double-click / retry so only one session is created. */
  idempotencyKey: z.string().min(1),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});
export type CheckoutInitRequest = z.infer<typeof CheckoutInitRequest>;

export const CheckoutInitResponse = Envelope.extend({
  /** Stripe-hosted Checkout URL to redirect the customer to. */
  checkoutUrl: z.string().url(),
  /** The price the Flux App will actually charge (MT confirms == listed before redirect). */
  priceCents: PriceCents,
  currency: Currency,
  /** Free-trial length applied (operator-selectable 1–7). */
  trialDays: z.number().int().min(0).max(7),
});
export type CheckoutInitResponse = z.infer<typeof CheckoutInitResponse>;

// ───────────────────────────────────────────────────────────────────────────
// 2. payment-event  —  operator Flux App → MT
//    Normalized Stripe webhook relayed outbound. The Flux App does NOT 200-ack
//    Stripe until MT accepts this, so Stripe's retry is the durable queue.
//    Auth: per-provider key. `stripeEventId` is the idempotency key at MT.
// ───────────────────────────────────────────────────────────────────────────
const PaymentEventBase = Envelope.extend({
  providerSlug: ProviderSlug,
  /** Stripe Event id — MT dedupes on this (idempotent). */
  stripeEventId: z.string().min(1),
  occurredAt: Timestamp,
});

export const PaymentEvent = z.discriminatedUnion("type", [
  // First subscription on a (trialing) checkout — MT creates Rental + Payment and
  // enqueues a provision job. No money has moved yet if trialing.
  PaymentEventBase.extend({
    type: z.literal("subscription.created"),
    stripeSubscriptionId: z.string().min(1),
    stripeCustomerId: z.string().min(1),
    mtCustomerId: z.string().min(1),
    email: z.string().email(),
    tier: TierKey,
    priceCents: PriceCents,
    currency: Currency,
    /** Set while in the free trial; absent once converted. */
    trialEndsAt: Timestamp.optional(),
    currentPeriodStart: Timestamp,
    currentPeriodEnd: Timestamp,
  }),
  // Renewal (or first real charge at trial end) succeeded — MT extends the rental.
  PaymentEventBase.extend({
    type: z.literal("invoice.payment_succeeded"),
    stripeSubscriptionId: z.string().min(1),
    amountPaidCents: z.number().int().nonnegative(),
    currency: Currency,
    currentPeriodStart: Timestamp,
    currentPeriodEnd: Timestamp,
  }),
  PaymentEventBase.extend({
    type: z.literal("invoice.payment_failed"),
    stripeSubscriptionId: z.string().min(1),
  }),
  // Cancelled (customer, operator decline, or oversell loser). Always a cancel,
  // never a refund — no money moved during the trial.
  PaymentEventBase.extend({
    type: z.literal("subscription.cancelled"),
    stripeSubscriptionId: z.string().min(1),
  }),
  // Operator-initiated refund/dispute reflected into MT's ledger (informational).
  PaymentEventBase.extend({
    type: z.literal("charge.refunded"),
    stripeSubscriptionId: z.string().optional(),
    stripeCustomerId: z.string().min(1),
    amountRefundedCents: z.number().int().nonnegative(),
  }),
]);
// Value + type share the name (zod pattern): use `PaymentEvent.parse(...)` for the
// schema and `Extract<PaymentEvent, { type: "..." }>` for a single variant.
export type PaymentEvent = z.infer<typeof PaymentEvent>;

// ───────────────────────────────────────────────────────────────────────────
// 3. job  —  MT → on-prem agent (claim response)
//    Provision/teardown instruction the agent PULLS. Carries NO hypervisor creds
//    (the agent injects its own local Proxmox token).
// ───────────────────────────────────────────────────────────────────────────
export const JobAction = z.enum(["provision", "delete", "reprovision", "move"]);
export type JobAction = z.infer<typeof JobAction>;

export const JobSlot = z.object({
  vmName: z.string().min(1),
  tier: TierKey,
  /** Proxmox node name on the operator side. */
  nodeName: z.string().min(1),
  ipAddress: z.string().min(1),
  lanIp: z.string().default(""),
  gateway: z.string().min(1),
  dns1: z.string().default("8.8.8.8"),
  dns2: z.string().default("1.1.1.1"),
  vlan: z.number().int().min(1).max(4094).nullable().default(null),
  apiPort: z.number().int().positive(),
  storagePool: z.string().nullable().default(null),
  vmId: z.number().int().positive().nullable().default(null),
  diskLimit: z.number().int().positive().nullable().default(null),
  cpuLimit: z.number().positive().nullable().default(null),
  networkLimit: z.number().int().positive().nullable().default(null),
  startupConfig: z.string().nullable().default(null), // e.g. "order=4,up=360"
  rateLimit: z.number().int().positive().nullable().default(null), // Mbps
});
export type JobSlot = z.infer<typeof JobSlot>;

export const Job = Envelope.extend({
  jobId: z.string().min(1),
  providerSlug: ProviderSlug,
  action: JobAction,
  /** Atomic lease: agent must report a result before this, else MT reclaims the job. */
  leaseExpiresAt: Timestamp,
  slot: JobSlot,
  /**
   * Customer Flux node identity — a secret, delivered over TLS to the authenticated
   * agent (same secret class a host receives today). Absent for delete jobs.
   */
  nodeConfig: z
    .object({
      fluxId: z.string().min(1),
      fluxIdentityKey: z.string().min(1),
      collateralTxid: z.string().min(1),
      collateralVout: z.number().int().nonnegative(),
      // Optional customer node-level alerts (passed through to the node's config).
      discordUserId: z.string().nullable().default(null),
      discordWebhook: z.string().nullable().default(null),
      telegramBotToken: z.string().nullable().default(null),
      telegramChatId: z.string().nullable().default(null),
    })
    .optional(),
});
export type Job = z.infer<typeof Job>;

// ───────────────────────────────────────────────────────────────────────────
// 4. result  —  agent → MT
// ───────────────────────────────────────────────────────────────────────────
export const JobResult = Envelope.extend({
  jobId: z.string().min(1),
  status: z.enum(["success", "failed"]),
  message: z.string().optional(),
  /** Proxmox VMID actually assigned (for traceability). */
  vmId: z.number().int().positive().optional(),
});
export type JobResult = z.infer<typeof JobResult>;

// ───────────────────────────────────────────────────────────────────────────
// 5. listing  —  agent → MT  (desired-state re-assert, on heartbeat + on change)
//    Authoritative mutable price/capacity. MT enforces priceCents >= floor and
//    retains last-known-good if a re-assert is missed (never resets to zero).
// ───────────────────────────────────────────────────────────────────────────
export const ListingTier = z.object({
  tier: TierKey,
  /** Operator's declared price (>= platform floor). MT materializes/mirrors this. */
  priceCents: PriceCents,
  capacity: z.number().int().nonnegative(),
  availableSlots: z.number().int().nonnegative(),
});
export type ListingTier = z.infer<typeof ListingTier>;

export const ListingAssert = Envelope.extend({
  providerSlug: ProviderSlug,
  assertedAt: Timestamp,
  tiers: z.array(ListingTier).min(1),
});
export type ListingAssert = z.infer<typeof ListingAssert>;

// ───────────────────────────────────────────────────────────────────────────
// 6. stats  —  published by the Flux App's external collector; MT PULLS it.
//    Hairpin-proof (polled from outside the operator LAN). No secrets.
// ───────────────────────────────────────────────────────────────────────────
export const StatsTier = z.object({
  tier: TierKey,
  meanEpsPerCore: z.number().nullable().default(null),
  meanDdwrite: z.number().nullable().default(null),
  uptimePct: z.number().min(0).max(100).nullable().default(null),
  nodeCount: z.number().int().nonnegative().default(0),
  pnrEligiblePct: z.number().min(0).max(100).nullable().default(null),
  arcaneOsPct: z.number().min(0).max(100).nullable().default(null),
  responseTimeHours: z.number().nonnegative().nullable().default(null),
});
export type StatsTier = z.infer<typeof StatsTier>;

// A live node the Flux App's collector should poll (public host:apiPort). MT is
// the authoritative source (it knows the provider's slots); the Flux App fetches
// this list via GET /api/agent/nodes, then polls each node's Flux API externally.
export const AgentNode = z.object({
  tier: TierKey,
  host: z.string().min(1),
  apiPort: z.number().int().positive(),
});
export type AgentNode = z.infer<typeof AgentNode>;

export const StatsSnapshot = Envelope.extend({
  providerSlug: ProviderSlug,
  collectedAt: Timestamp,
  windowDays: z.number().int().positive().default(90),
  tiers: z.array(StatsTier),
});
export type StatsSnapshot = z.infer<typeof StatsSnapshot>;

// ───────────────────────────────────────────────────────────────────────────
// 7. manage  —  MT → operator Flux App  (customer self-service)
//    Open the operator-account billing portal, or cancel a subscription.
//    Auth: MT-issued key.
// ───────────────────────────────────────────────────────────────────────────
export const ManageRequest = Envelope.extend({
  providerSlug: ProviderSlug,
  action: z.enum(["open_portal", "cancel"]),
  stripeSubscriptionId: z.string().min(1),
  /** Where the billing portal returns the customer (for open_portal). */
  returnUrl: z.string().url().optional(),
});
export type ManageRequest = z.infer<typeof ManageRequest>;

export const ManageResponse = Envelope.extend({
  /** Present for open_portal; absent for a completed cancel. */
  portalUrl: z.string().url().optional(),
  ok: z.boolean(),
});
export type ManageResponse = z.infer<typeof ManageResponse>;

// ───────────────────────────────────────────────────────────────────────────
// 7. health  —  agent → MT  (periodic per-node VM liveness from local Proxmox)
//    The agent can see its own hypervisor; MT cannot (operator hosts live outside
//    MT's cluster API). So the operator reports each owned VM's running state and
//    MT raises node_down from it — plus a staleness check when the agent goes
//    silent. Auth: per-provider agent key (provider-scoped).
// ───────────────────────────────────────────────────────────────────────────
export const NodeHealth = z.object({
  vmName: z.string().min(1),
  running: z.boolean(),
  /** Raw Proxmox status (running|stopped|paused|…) or "missing" if not found. */
  status: z.string().min(1),
});
export type NodeHealth = z.infer<typeof NodeHealth>;

export const HealthReport = Envelope.extend({
  providerSlug: ProviderSlug,
  reportedAt: Timestamp,
  nodes: z.array(NodeHealth),
});
export type HealthReport = z.infer<typeof HealthReport>;
