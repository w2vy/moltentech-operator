import { z } from "zod";
import {
  Currency,
  Envelope,
  NoCtrl,
  PriceCents,
  ProviderSlug,
  TierKey,
  Timestamp,
} from "./common";

// ───────────────────────────────────────────────────────────────────────────
// 1. checkout-init  —  MT → operator Coalition
//    MT asks the Coalition to quote the price and mint a subscription Checkout
//    Session (trial enabled) on the OPERATOR's Stripe account. Auth: MT-issued key.
// ───────────────────────────────────────────────────────────────────────────
export const CheckoutInitRequest = Envelope.extend({
  providerSlug: ProviderSlug,
  tier: TierKey,
  /** The MT customer buying — the Coalition passes email to Checkout and echoes mtCustomerId back in events. */
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
  /** The price the Coalition will actually charge (MT confirms == listed before redirect). */
  priceCents: PriceCents,
  currency: Currency,
  /** Free-trial length applied (operator-selectable 1–7). */
  trialDays: z.number().int().min(0).max(7),
});
export type CheckoutInitResponse = z.infer<typeof CheckoutInitResponse>;

// ───────────────────────────────────────────────────────────────────────────
// 2. payment-event  —  operator Coalition → MT
//    Normalized Stripe webhook relayed outbound. The Coalition does NOT 200-ack
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

// ── Owner authorization (Phase C) ────────────────────────────────────────────
//
// Destructive/relocating actions carry the node owner's explicit consent as a
// Flux-wallet (secp256k1) signature the OPERATOR verifies against a self-pinned
// owner address — so even a fully compromised MT can't move or delete a node it
// merely relays the job for. Provision (a paid, customer-initiated create) is not
// privileged; delete / reprovision / move are.

const PRIVILEGED_ACTIONS = new Set<JobAction>(["delete", "reprovision", "move"]);

/** True for actions that require an owner-authorization signature to execute. */
export function isPrivilegedAction(action: JobAction): boolean {
  return PRIVILEGED_ACTIONS.has(action);
}

/** The owner-signed fields that bind an authorization to one action on one node. */
export const OwnerAuthClaim = z.object({
  action: JobAction,
  providerSlug: ProviderSlug,
  vmName: z.string().min(1),
  nodeName: z.string().min(1),
  /** Single-use token; the operator rejects a repeated nonce (replay guard). */
  nonce: z.string().min(1),
  /** The operator refuses the authorization at/after this instant. */
  expiresAt: Timestamp,
});
export type OwnerAuthClaim = z.infer<typeof OwnerAuthClaim>;

/** A signed owner authorization: the bound claim + the Flux `signmessage` signature. */
export const OwnerAuth = OwnerAuthClaim.extend({
  /** 65-byte compact recoverable Flux `signmessage` signature over `ownerAuthMessage`, base64. */
  signature: z.string().min(1),
});
export type OwnerAuth = z.infer<typeof OwnerAuth>;

/**
 * The exact, human-readable string the owner signs in their wallet. Deterministic
 * so the `mt-authorize` signer and the operator verifier derive identical bytes;
 * readable so the owner can review the action in-wallet before signing.
 */
export function ownerAuthMessage(c: OwnerAuthClaim): string {
  return [
    "MoltenTech owner authorization",
    `action: ${c.action}`,
    `provider: ${c.providerSlug}`,
    `vm: ${c.vmName}@${c.nodeName}`,
    `nonce: ${c.nonce}`,
    `expires: ${c.expiresAt}`,
  ].join("\n");
}

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
      // No control chars (newlines/CR/etc.): these values are written into the
      // provision YAML, so a newline would let a crafted value inject sibling keys.
      // Defense in depth — MT validates format at ingestion; the agent refuses
      // anything malformed at its own trust boundary too.
      fluxId: NoCtrl.min(1),
      fluxIdentityKey: NoCtrl.min(1),
      collateralTxid: NoCtrl.min(1),
      collateralVout: z.number().int().nonnegative(),
      // Optional customer node-level alerts (passed through to the node's config).
      discordUserId: NoCtrl.nullable().default(null),
      discordWebhook: NoCtrl.nullable().default(null),
      telegramBotToken: NoCtrl.nullable().default(null),
      telegramChatId: NoCtrl.nullable().default(null),
    })
    .optional(),
  /**
   * Owner (Flux-wallet) authorization. REQUIRED for privileged actions
   * (delete / reprovision / move) — the agent refuses to execute them without a
   * valid signature. MT only relays this; it cannot forge it. See `OwnerAuth`.
   */
  ownerAuth: OwnerAuth.optional(),
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
//    inventory-assert  —  operator agent → MT
//    The operator DECLARES its agent-managed hosts + slots (the physical facts
//    only the operator knows) so MT materializes the ProxmoxHost/Slot rows from
//    the operator side, instead of an admin hand-inserting them. Provider-scoped
//    by the agent signature; upsert-only (MT never hard-deletes rented slots).
// ───────────────────────────────────────────────────────────────────────────
/** One agent-managed slot the operator offers (maps to a Slot row). */
export const InventorySlot = z.object({
  tier: TierKey,
  vmName: z.string().min(1),
  ipAddress: z.string().min(1),
  lanIp: z.string().default(""),
  gateway: z.string().min(1),
  dns1: z.string().default("8.8.8.8"),
  dns2: z.string().default("1.1.1.1"),
  apiPort: z.number().int().positive(),
  vlan: z.number().int().min(1).max(4094).optional(),
  rateLimit: z.number().int().positive().optional(),
  storagePool: z.string().min(1).optional(),
  vmId: z.number().int().positive().optional(),
  startupConfig: z.string().min(1).optional(),
  diskLimit: z.number().int().positive().optional(),
  cpuLimit: z.number().positive().optional(),
  networkLimit: z.number().int().positive().optional(),
  /** Operator price for this slot's tier (>= platform floor); null = floor. */
  priceCents: PriceCents.optional(),
});
export type InventorySlot = z.infer<typeof InventorySlot>;

/** One agent-managed Proxmox host + the slots it carries (maps to a ProxmoxHost row). */
export const InventoryHost = z.object({
  /** Globally-unique host label (ProxmoxHost.name). */
  name: z.string().min(1),
  /** Proxmox node name the agent provisions on. */
  nodeName: z.string().min(1),
  /** Reference API URL (agent injects its own creds; MT never calls it for agent hosts). */
  apiUrl: z.string().min(1).optional(),
  storageImages: z.string().min(1).optional(),
  storageIso: z.string().min(1).optional(),
  slots: z.array(InventorySlot),
});
export type InventoryHost = z.infer<typeof InventoryHost>;

export const InventoryAssert = Envelope.extend({
  providerSlug: ProviderSlug,
  assertedAt: Timestamp,
  hosts: z.array(InventoryHost),
});
export type InventoryAssert = z.infer<typeof InventoryAssert>;

// ───────────────────────────────────────────────────────────────────────────
//    owner-authorization courier  —  agent ⇄ operator Coalition console
//    The agent fetches the provider's pending privileged actions from MT and
//    PUSHES them to the coalition console (so the operator can sign them); the
//    coalition returns the operator-signed authorizations for the agent to relay
//    to MT. Keeps the key-holding agent outbound-only; the coalition holds no keys.
// ───────────────────────────────────────────────────────────────────────────
/** A privileged action awaiting the owner's signature (mirrors GET /api/agent/pending-auth). */
export const PendingAuthItem = z.object({
  slotId: z.string().min(1),
  action: JobAction,
  providerSlug: ProviderSlug,
  vmName: z.string().min(1),
  nodeName: z.string().min(1),
  rentalCode: z.string().nullable(),
});
export type PendingAuthItem = z.infer<typeof PendingAuthItem>;

/** Agent → coalition: the current pending list to present for signing. */
export const PendingAuthPush = z.object({ items: z.array(PendingAuthItem) });
export type PendingAuthPush = z.infer<typeof PendingAuthPush>;

/** One operator-signed authorization, bound to the slot it authorizes. */
export const SignedAuthorization = z.object({ slotId: z.string().min(1), ownerAuth: OwnerAuth });
export type SignedAuthorization = z.infer<typeof SignedAuthorization>;

/** Coalition → agent: the signed authorizations queued since the last poll. */
export const AuthorizationList = z.object({ items: z.array(SignedAuthorization) });
export type AuthorizationList = z.infer<typeof AuthorizationList>;

// ───────────────────────────────────────────────────────────────────────────
// 6. stats  —  published by the Coalition's external collector; MT PULLS it.
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

/** Slot lifecycle status MT tracks for a provisioned-but-not-yet-active node. */
export const SlotLifecycleStatus = z.enum(["bootstrap", "benchmark", "awaiting_start", "active"]);
export type SlotLifecycleStatus = z.infer<typeof SlotLifecycleStatus>;

// A live node the Coalition's collector should poll (public host:apiPort). MT is
// the authoritative source (it knows the provider's slots); the Coalition fetches
// this list via GET /api/agent/nodes, then polls each node's Flux API externally.
// `status`/`collateralTxid`/`collateralVout` are present for non-active slots only
// (bootstrap/benchmark/awaiting_start) — the fields the Coalition's collateral
// lifecycle collector needs; absent once a slot is `active`.
export const AgentNode = z.object({
  tier: TierKey,
  host: z.string().min(1),
  apiPort: z.number().int().positive(),
  status: SlotLifecycleStatus.optional(),
  collateralTxid: z.string().min(1).optional(),
  collateralVout: z.number().int().nonnegative().optional(),
});
export type AgentNode = z.infer<typeof AgentNode>;

// ───────────────────────────────────────────────────────────────────────────
// 8. lifecycle  —  operator Coalition → MT  (agent-managed collateral guard)
//    The Coalition polls each non-active node's benchmark endpoint + the public
//    Flux blockchain API (collateral confirmations, deterministic-list membership)
//    and reports the raw measurements here; MT alone decides Slot transitions and
//    fires customer notifications, mirroring apps/provisioner/index.js's
//    checkBenchmarks() but for agent-managed slots. Coalition makes no decisions —
//    same relay-raw-facts pattern as PaymentEvent. Auth: per-provider agent key.
// ───────────────────────────────────────────────────────────────────────────
export const LifecycleNodeStatus = z.object({
  vmName: z.string().min(1),
  /** Node self-reported a supported tier via its benchmark API this poll. */
  benchmarkPassed: z.boolean(),
  /** Collateral UTXO confirmations (getblockcount - tx.height + 1); null = unreadable (fail-closed upstream). */
  collateralConfs: z.number().int().nonnegative().nullable(),
  /** True once the node's collateral appears on the Flux deterministic node list. */
  onDeterministicList: z.boolean(),
});
export type LifecycleNodeStatus = z.infer<typeof LifecycleNodeStatus>;

export const LifecycleReport = Envelope.extend({
  providerSlug: ProviderSlug,
  reportedAt: Timestamp,
  nodes: z.array(LifecycleNodeStatus),
});
export type LifecycleReport = z.infer<typeof LifecycleReport>;

export const StatsSnapshot = Envelope.extend({
  providerSlug: ProviderSlug,
  collectedAt: Timestamp,
  windowDays: z.number().int().positive().default(90),
  tiers: z.array(StatsTier),
});
export type StatsSnapshot = z.infer<typeof StatsSnapshot>;

// ───────────────────────────────────────────────────────────────────────────
// 7. manage  —  MT → operator Coalition  (customer self-service)
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
