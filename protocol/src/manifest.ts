import { z } from "zod";
import { Envelope, ProviderSlug, Timestamp } from "./common";

/**
 * Provider Manifest — the operator's signed self-description, published as a
 * static JSON blob at the Coalition's stable HTTPS URL and **pulled** by MT.
 *
 * Trust model:
 * - Signed **offline** with the operator's ed25519 key; `signature` is detached
 *   and covers the canonical JSON of every field EXCEPT `signature` itself.
 * - It is the **onboarding identity handshake only** — slow-changing. It does
 *   NOT carry secrets, does NOT advertise the operator's Proxmox `:8006`, and
 *   does NOT carry authoritative price (price is asserted by the agent via the
 *   listing message and materialized into the operator's Stripe Price).
 * - Served as immutable-per-deploy config so multiple Coalition instances are
 *   byte-identical (Syncthing replicates, never merges).
 */
export const ProviderManifestHardware = z.object({
  /** ProxmoxHost.name the operator attests exists (1:1 with a machine post-pve40-merge). */
  name: z.string().min(1),
});
export type ProviderManifestHardware = z.infer<typeof ProviderManifestHardware>;

export const ProviderManifestBody = Envelope.extend({
  provider: z.object({
    slug: ProviderSlug,
    name: z.string().min(1),
    location: z.string().optional(),
    description: z.string().optional(),
    contact: z.string().optional(),
  }),
  /** Stable HTTPS base URL of the operator's Coalition (stats pull + payment/manage endpoints). */
  coalitionUrl: z.string().url(),
  /** ed25519 public key (base64) used to verify `signature`. */
  pubkey: z.string().min(1),
  /**
   * Flux/ZelID wallet address that authorizes this manifest's `pubkey` (proven, not
   * blind, TOFU). When present + accompanied by a matching `ownerSignature`
   * (see `SignedProviderManifest`), MT pins it as the provider's proven identity and
   * can safely auto-accept a later pubkey rotation from the same owner.
   *
   * Optional for backward compatibility: a legacy manifest without it still ingests
   * via the original blind-TOFU path. Same real wallet as the agent's
   * `OWNER_ADDRESS` in most cases, but a DISTINCT trust chain — this authorizes
   * manifest *ingestion/identity*, whereas the `OwnerAuth` flow in `messages.ts`
   * authorizes privileged *jobs* (delete/move/reprovision). See
   * project_moltentech_wallet_manifest_auth.
   */
  ownerAddress: z.string().min(1).optional(),
  /** Hardware (Proxmox host rows) the operator attests. Tiers/counts derive from inventory. */
  hardware: z.array(ProviderManifestHardware).min(1),
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

/**
 * A manifest whose `pubkey` is authorized by an owner wallet signature — the
 * onboarding payload that turns MT's blind-TOFU pubkey pin into *proven* ownership.
 * Ingest of this variant unlocks auto-accepted pubkey rotation (same owner) and
 * zero-click key issuance; a bare `ProviderManifest` still ingests via the legacy
 * path. Produced by `mt-manifest authorize`; verified by `verifyManifestOwnerSignature`.
 */
export const SignedProviderManifest = z.object({
  manifest: ProviderManifest,
  /** 65-byte compact recoverable Flux `signmessage` signature over `manifestOwnerMessage`, base64. */
  ownerSignature: z.string().min(1),
});
export type SignedProviderManifest = z.infer<typeof SignedProviderManifest>;

/**
 * The exact, human-readable string the operator's wallet signs to authorize a
 * manifest's identity. Deterministic (the `mt-manifest authorize` signer and MT's
 * verifier derive identical bytes) and readable (the owner reviews slug/pubkey/owner
 * in-wallet before signing). Mirrors the `ownerAuthMessage` pattern in `messages.ts`.
 *
 * Includes the manifest's own ed25519 `signature`, so the wallet signature is CHAINED
 * to that exact signed body — a party can't swap in a different ed25519 signature over
 * the same fields without invalidating the wallet signature too. Requires
 * `ownerAddress` to be present on the manifest.
 */
export function manifestOwnerMessage(m: ProviderManifest): string {
  if (!m.ownerAddress) throw new Error("manifest has no ownerAddress to authorize");
  return [
    "MoltenTech provider manifest authorization",
    `provider: ${m.provider.slug}`,
    `pubkey: ${m.pubkey}`,
    `owner: ${m.ownerAddress}`,
    `published: ${m.publishedAt}`,
    `manifest-sig: ${m.signature}`,
  ].join("\n");
}

/**
 * Split a manifest payload into its parts, whether it is a bare `ProviderManifest`
 * (legacy) or a `SignedProviderManifest` wrapper. Pure shape probe — does NOT verify
 * either signature; callers still run `verifyManifestObject` (ed25519) and, when an
 * `ownerSignature` is present, `verifyManifestOwnerSignature` (owner wallet).
 *
 * The single source of the on-the-wire wrapper shape, reused by every consumer of a
 * published manifest (MT ingest, the `mt-manifest env` bundler, the Coalition console)
 * so the detection lives in exactly one place.
 */
export function unwrapManifest(raw: unknown): { manifest: unknown; ownerSignature?: string } {
  if (raw && typeof raw === "object" && "manifest" in raw && "ownerSignature" in raw) {
    return {
      manifest: (raw as { manifest: unknown }).manifest,
      ownerSignature: (raw as { ownerSignature: unknown }).ownerSignature as string,
    };
  }
  return { manifest: raw };
}
