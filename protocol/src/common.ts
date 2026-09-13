import { z } from "zod";

/**
 * Bump when a breaking change is made to any message or the manifest. Every
 * payload carries `schemaVersion` so the receiver can reject mismatches.
 */
export const SCHEMA_VERSION = 2 as const;

/** The three hosting tiers. Floor prices live in the web app (`lib/tiers.ts`). */
export const TierKey = z.enum(["cumulus", "nimbus", "stratus"]);
export type TierKey = z.infer<typeof TierKey>;

/**
 * Platform-controlled provider identifier (lowercase slug). Operators may not
 * change it via manifest/listing — it is assigned at onboarding.
 */
export const ProviderSlug = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase kebab-case");

/**
 * The VM-name namespace a provider owns: 2–8 lowercase alphanumerics, letter first, WITH
 * the trailing "-". The separator is part of the value so uniqueness is plain equality
 * and never a prefix-overlap question (`mt-` vs `mtc-` are different namespaces; `mt` vs
 * `mtc` would not be). No hyphen inside: `mt-c-` would emit `mt-c-1`, which also starts
 * with `mt-` and so lands inside someone else's namespace.
 *
 * Format only. Reservation (`fh-` is the Foundation's) and uniqueness are hub policy,
 * enforced at ingest — see the hub's `lib/name-availability.ts`.
 */
export const VM_NAME_PREFIX_RULE = "2–8 lowercase letters/digits, starting with a letter, ending in '-' (e.g. mt-)";
export const VmNamePrefix = z.string().regex(/^[a-z][a-z0-9]{1,7}-$/, VM_NAME_PREFIX_RULE);

/**
 * A single-line string with no control characters (newlines, CR, tabs, NUL, etc.).
 * Use for any value that gets written into a structured document (e.g. the provision
 * YAML) where an embedded newline could inject syntax. Rejects C0 controls + DEL.
 */
// eslint-disable-next-line no-control-regex
export const NoCtrl = z.string().regex(/^[^\u0000-\u001f\u007f]*$/, "control characters not allowed");

/** Money is always integer cents. v1 is USD-only; currency is explicit for forward-compat. */
export const PriceCents = z.number().int().positive();
export const Currency = z.enum(["usd"]); // multi-currency = later manifest field

/** ISO-8601 instant, e.g. "2026-06-23T18:30:00.000Z". */
export const Timestamp = z.string().datetime();

/**
 * Flux rejects a fluxnode START whose collateral UTXO has under this many
 * confirmations and applies a DoS-score cooldown, so the customer's "go start
 * your node" cue is withheld until collateral matures. Shared by MT's
 * lifecycle-guard decision logic and the Coalition's console display; MT's
 * first-party central provisioner (`apps/provisioner/index.js`, plain JS, no
 * import boundary crosses the runtime split) keeps its own copy in sync by hand.
 */
export const COLLATERAL_MIN_CONFIRMATIONS = 100;

/**
 * Auth conventions (carried in HTTP headers, not the JSON body):
 * - Coalition → MT and agent → MT: `Authorization: Bearer <per-provider key>`;
 *   MT stores only `sha256(key)` as `Provider.agentKeyHash` and scopes every
 *   query to the matched provider.
 * - MT → Coalition (checkout-init / manage): `Authorization: Bearer <MT-issued key>`
 *   so randoms can't mint sessions on the operator's Stripe account.
 */
export const HEADER_AUTHORIZATION = "authorization";
/**
 * Asymmetric request-envelope signature (Phase 0a+, replaces the symmetric
 * `Authorization: Bearer` tokens above). Carries the base64 ed25519 detached
 * signature produced by `signRequest`; the signed envelope fields travel in the
 * body/headers so the verifier re-derives the exact bytes. See `./signing`.
 */
export const HEADER_MT_SIGNATURE = "x-mt-signature";
/**
 * Agent → MT request-envelope signature (Phase B, replaces the symmetric
 * `agentKey` bearer). The agent signs the envelope with its manifest ed25519
 * key (the private half of `Provider.manifestPubkey`) and MT re-derives + verifies
 * it against that pinned pubkey. Unlike the single-tenant Coalition, MT serves many
 * providers, so the claimed provider slug travels in `HEADER_AGENT_SLUG` (bound
 * into the signed envelope, so a forged slug fails verification).
 */
export const HEADER_AGENT_SIGNATURE = "x-agent-signature";
export const HEADER_AGENT_TIMESTAMP = "x-agent-timestamp";
export const HEADER_AGENT_NONCE = "x-agent-nonce";
export const HEADER_AGENT_SLUG = "x-agent-slug";
/**
 * Coalition → MT request-envelope signature (Phase D, replaces the symmetric
 * `agentKey` bearer on the Coalition's four outbound reports).
 *
 * Deliberately NOT the `x-agent-*` headers, even though the envelope shape and the
 * verifier are identical: the Coalition signs with its own `COALITION_SIGNING_KEY`
 * (private half of `Provider.coalitionPubkey`), never the agent's manifest key, and
 * the two processes are separate deploy targets with separate compromise stories.
 * Distinct header names keep "which identity signed this" unambiguous in logs and in
 * MT's verifier, which admits the Coalition identity on only three routes.
 */
export const HEADER_COALITION_SIGNATURE = "x-coalition-signature";
export const HEADER_COALITION_TIMESTAMP = "x-coalition-timestamp";
export const HEADER_COALITION_NONCE = "x-coalition-nonce";
export const HEADER_COALITION_SLUG = "x-coalition-slug";
/**
 * Running code versions, informational and UNSIGNED. The Coalition stamps its version on
 * every response it serves the hub (the stats pull records it as `Provider.coalitionVersion`);
 * the agent stamps its version on every request it makes to the hub (recorded as
 * `Provider.agentVersion` inside the same update that already writes `agentLastSeenAt`,
 * i.e. after signature verification). Deliberately NOT part of the signed envelope and NOT a
 * body field: a header is out-of-band, so an older hub ignores it and an older agent simply
 * never sends it (the hub reads absence as "unknown", never as "outdated"). Only the holder
 * of the signing key can get a value past the hub's verifier, and the value only ever drives
 * a display. See candid-versioning-lovelace.
 */
export const HEADER_COALITION_VERSION = "x-coalition-version";
export const HEADER_AGENT_VERSION = "x-agent-version";
/** Stripe-style idempotency: dedupe retried deliveries of the same logical event. */
export const HEADER_IDEMPOTENCY_KEY = "idempotency-key";

/** Envelope every message extends, so version-skew is caught uniformly. */
export const Envelope = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
});
