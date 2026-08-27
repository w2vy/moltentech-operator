import { readFileSync } from "node:fs";
import { z } from "zod";
import { TierKey } from "@moltentech/protocol";

const TierPrices = z.record(TierKey, z.number().int().positive());

export type CoalitionConfig = {
  port: number;
  providerSlug: string;
  mtBaseUrl: string;
  /** Per-provider key the Coalition uses to relay payment events to MT (operator -> MT). */
  agentKey: string;
  /** MT-issued key the Coalition requires on inbound /checkout and /manage (MT -> operator). */
  coalitionKey: string;
  /**
   * Ed25519 private key the Coalition SIGNS its four outbound reports to MT with
   * (Phase D) — base64 of the raw 32-byte seed, as `issueProviderKeys` hands it over
   * at onboarding, or base64 of a PKCS#8 PEM from `mt-manifest coalition-keygen`.
   *
   * SECRET. Optional on purpose: unset keeps the legacy `AGENT_KEY` bearer, which is
   * what lets operators cut over one at a time. Distinct from the agent's MANIFEST_KEY
   * — the Coalition must never hold that one.
   */
  coalitionSigningKey?: string;
  /**
   * Global MT ed25519 public key (base64 raw), pinned at deploy from MT's
   * /api/mt-pubkey. When set, inbound /checkout + /manage are verified by
   * signature; the `coalitionKey` bearer stays as a dual-accept fallback. Leave
   * unset to keep bearer-only until the operator has pinned the key.
   */
  mtPubkey?: string;
  /** Operator's restricted Stripe key + webhook signing secret (the only secrets here). */
  /** Stripe credentials are OPTIONAL: required only when a PAID tier is listed.
   * A self-hoster running their own nodes on Foundation collateral has no customers
   * and should never have needed a Stripe account — but `req()` threw on these, so
   * the Coalition would not start at all without them. */
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  /** Path to the offline-signed manifest JSON served at /.well-known/mt-provider.json. */
  manifestPath: string;
  /**
   * Signed manifest JSON supplied directly via the MANIFEST_JSON env var (Flux
   * published-image deploy, where there is no file to mount). When set it wins
   * over manifestPath; unset falls back to the file (compose/dev mount it).
   */
  manifestJson?: string;
  /**
   * The operator's owner ZelID — the console authorizes only signatures that
   * recover to it (the login-less per-action gate). Defaults to the same address
   * the agent pins as OWNER_ADDRESS. (Future: resolve via Flux app-owner lookup.)
   */
  ownerAddress?: string;
  /**
   * Cookie-signing secret for the console wallet-login (CV6). When SET, the console
   * read routes are gated behind a wallet login; when UNSET the console is open
   * (LAN/dev). Low-value: signs only the read-gate cookie, never authorizes actions.
   */
  sessionSecret?: string;
  /** Console session lifetime (ms). Read-gate only, so it can be generous. */
  sessionTtlMs: number;
  /** Operator-declared price per tier (cents); the Coalition materializes the Stripe Price. */
  tierPrices: Record<string, number>;
  trialDays: number;
  statsWindowDays: number;
  /** Flux public API base for the collateral-guard collector (confs + deterministic-list). */
  fluxApiUrl: string;
};

function req(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`Missing required env ${k}`);
  return v;
}

/**
 * The signed manifest body served at /.well-known/mt-provider.json (and read by the
 * console for the agent-auth pubkey). Prefers MANIFEST_JSON env (Flux published-image
 * deploy); falls back to the file at manifestPath (compose/dev mounts it). Throws when
 * neither source is available — callers handle that (503 / empty).
 */
export function readManifest(cfg: CoalitionConfig): string {
  return cfg.manifestJson ?? readFileSync(cfg.manifestPath, "utf8");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoalitionConfig {
  const cfg: CoalitionConfig = {
    port: Number(env.PORT ?? 8088),
    providerSlug: req(env, "PROVIDER_SLUG"),
    mtBaseUrl: req(env, "MT_BASE_URL").replace(/\/$/, ""),
    agentKey: req(env, "AGENT_KEY"),
    coalitionKey: req(env, "COALITION_KEY"),
    coalitionSigningKey: env.COALITION_SIGNING_KEY || undefined,
    mtPubkey: env.MT_PUBKEY || undefined,
    stripeSecretKey: env.STRIPE_SECRET_KEY || undefined,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined,
    manifestPath: env.MANIFEST_PATH ?? "./manifest.json",
    manifestJson: env.MANIFEST_JSON || undefined,
    ownerAddress: env.OWNER_ADDRESS || undefined,
    sessionSecret: env.SESSION_SECRET || undefined,
    sessionTtlMs: Number(env.SESSION_TTL_HOURS ?? 24) * 3_600_000,
    tierPrices: TierPrices.parse(JSON.parse(req(env, "TIER_PRICES_JSON"))),
    trialDays: Number(env.TRIAL_DAYS ?? 1),
    statsWindowDays: Number(env.STATS_WINDOW_DAYS ?? 90),
    fluxApiUrl: (env.FLUX_API ?? "https://api.runonflux.io").replace(/\/$/, ""),
  };

  // Fail fast, and name the tier: listing something for sale with no way to charge
  // for it is a misconfiguration, but ONLY then.
  //
  // ⚠️ "Free" means listing NO tiers — not listing one at price 0. MT enforces a
  // per-tier price floor (700 cents at the lowest) and 422s anything below it, so a
  // 0-priced listing cannot exist; `TierPrices` requires a positive integer for the
  // same reason. A self-hoster renting to themselves uses the hub's free-rental path,
  // which never touches a Stripe Price.
  const paidTiers = Object.keys(cfg.tierPrices);
  if (paidTiers.length > 0) {
    const missing = (["stripeSecretKey", "stripeWebhookSecret"] as const)
      .filter((k) => !cfg[k])
      .map((k) => (k === "stripeSecretKey" ? "STRIPE_SECRET_KEY" : "STRIPE_WEBHOOK_SECRET"));
    if (missing.length > 0) {
      throw new Error(
        `Missing required env ${missing.join(" and ")} — you list PAID tier(s): ` +
          `${paidTiers.join(", ")}. Run with TIER_PRICES_JSON={} to sell nothing and skip Stripe.`
      );
    }
  }
  return cfg;
}
