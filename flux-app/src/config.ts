import { z } from "zod";
import { TierKey } from "@moltentech/protocol";

const TierPrices = z.record(TierKey, z.number().int().positive());

export type FluxAppConfig = {
  port: number;
  providerSlug: string;
  mtBaseUrl: string;
  /** Per-provider key the Flux App uses to relay payment events to MT (operator -> MT). */
  agentKey: string;
  /** MT-issued key the Flux App requires on inbound /checkout and /manage (MT -> operator). */
  fluxAppKey: string;
  /** Operator's restricted Stripe key + webhook signing secret (the only secrets here). */
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  /** Path to the offline-signed manifest JSON served at /.well-known/mt-provider.json. */
  manifestPath: string;
  /** Operator-declared price per tier (cents); the Flux App materializes the Stripe Price. */
  tierPrices: Record<string, number>;
  trialDays: number;
  statsWindowDays: number;
};

function req(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`Missing required env ${k}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FluxAppConfig {
  return {
    port: Number(env.PORT ?? 8088),
    providerSlug: req(env, "PROVIDER_SLUG"),
    mtBaseUrl: req(env, "MT_BASE_URL").replace(/\/$/, ""),
    agentKey: req(env, "AGENT_KEY"),
    fluxAppKey: req(env, "FLUXAPP_KEY"),
    stripeSecretKey: req(env, "STRIPE_SECRET_KEY"),
    stripeWebhookSecret: req(env, "STRIPE_WEBHOOK_SECRET"),
    manifestPath: env.MANIFEST_PATH ?? "./manifest.json",
    tierPrices: TierPrices.parse(JSON.parse(req(env, "TIER_PRICES_JSON"))),
    trialDays: Number(env.TRIAL_DAYS ?? 1),
    statsWindowDays: Number(env.STATS_WINDOW_DAYS ?? 90),
  };
}
