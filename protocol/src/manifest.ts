import { z } from "zod";
import { Envelope, ProviderSlug, TierKey, Timestamp } from "./common";

/**
 * Provider Manifest — the operator's signed self-description, published as a
 * static JSON blob at the Flux App's stable HTTPS URL and **pulled** by MT.
 *
 * Trust model:
 * - Signed **offline** with the operator's ed25519 key; `signature` is detached
 *   and covers the canonical JSON of every field EXCEPT `signature` itself.
 * - It is the **onboarding identity handshake only** — slow-changing. It does
 *   NOT carry secrets, does NOT advertise the operator's Proxmox `:8006`, and
 *   does NOT carry authoritative price (price is asserted by the agent via the
 *   listing message and materialized into the operator's Stripe Price).
 * - Served as immutable-per-deploy config so multiple Flux App instances are
 *   byte-identical (Syncthing replicates, never merges).
 */
export const ProviderManifestTier = z.object({
  tier: TierKey,
  /** Max nodes the operator offers for this tier (respects the 8/WAN-IP Flux cap upstream). */
  capacity: z.number().int().nonnegative(),
  /** Proxmox storage ID for the VM disk on the operator side (e.g. "local-lvm"). */
  storagePool: z.string().min(1),
});
export type ProviderManifestTier = z.infer<typeof ProviderManifestTier>;

export const ProviderManifestBody = Envelope.extend({
  provider: z.object({
    slug: ProviderSlug,
    name: z.string().min(1),
    location: z.string().optional(),
    description: z.string().optional(),
    contact: z.string().optional(),
  }),
  /** Stable HTTPS base URL of the operator's Flux App (stats pull + payment/manage endpoints). */
  fluxAppUrl: z.string().url(),
  /** ed25519 public key (base64) used to verify `signature`. */
  pubkey: z.string().min(1),
  /** Tiers the operator offers (price is NOT here — see listing assert). */
  tiers: z.array(ProviderManifestTier).min(1),
  /** Operator-selectable free-trial window in days (1–7); MT defaults missing to 1. */
  trialDays: z.number().int().min(1).max(7).default(1),
  /** Cautious operators may require manual approval before provisioning a trial. */
  manualApproval: z.boolean().default(false),
  /** Operator-declared service flags (card metadata + marketplace filters). */
  serviceFlags: z
    .object({
      delegationAvailable: z.boolean().default(false),
      autoRenew: z.boolean().default(true),
      whiteLabel: z.boolean().default(false),
      sla: z.string().optional(),
      languages: z.array(z.string()).default([]),
      supportChannels: z.string().optional(),
      dataCenters: z.string().optional(),
    })
    .default({}),
  /** Ignored by MT — trust is platform-controlled at onboarding. Present so naive operators can't grant themselves trust. */
  trustedSelfClaim: z.literal(false).default(false),
  publishedAt: Timestamp,
});
export type ProviderManifestBody = z.infer<typeof ProviderManifestBody>;

/** The full published document: signed body + detached signature. */
export const ProviderManifest = ProviderManifestBody.extend({
  /** ed25519 signature (base64) over the canonical JSON of the body (this field excluded). */
  signature: z.string().min(1),
});
export type ProviderManifest = z.infer<typeof ProviderManifest>;
