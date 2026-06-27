import { z } from "zod";

/**
 * Bump when a breaking change is made to any message or the manifest. Every
 * payload carries `schemaVersion` so the receiver can reject mismatches.
 */
export const SCHEMA_VERSION = 1 as const;

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

/** Money is always integer cents. v1 is USD-only; currency is explicit for forward-compat. */
export const PriceCents = z.number().int().positive();
export const Currency = z.enum(["usd"]); // multi-currency = later manifest field

/** ISO-8601 instant, e.g. "2026-06-23T18:30:00.000Z". */
export const Timestamp = z.string().datetime();

/**
 * Auth conventions (carried in HTTP headers, not the JSON body):
 * - Flux App → MT and agent → MT: `Authorization: Bearer <per-provider key>`;
 *   MT stores only `sha256(key)` as `Provider.agentKeyHash` and scopes every
 *   query to the matched provider.
 * - MT → Flux App (checkout-init / manage): `Authorization: Bearer <MT-issued key>`
 *   so randoms can't mint sessions on the operator's Stripe account.
 */
export const HEADER_AUTHORIZATION = "authorization";
/** Stripe-style idempotency: dedupe retried deliveries of the same logical event. */
export const HEADER_IDEMPOTENCY_KEY = "idempotency-key";

/** Envelope every message extends, so version-skew is caught uniformly. */
export const Envelope = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
});
