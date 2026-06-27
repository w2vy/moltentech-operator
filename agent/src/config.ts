import { z } from "zod";
import { TierKey } from "@moltentech/protocol";

/** One tier's desired listing state, re-asserted to MT on a heartbeat. */
const ListingTierConfig = z.object({
  tier: TierKey,
  priceCents: z.number().int().positive(),
  capacity: z.number().int().nonnegative(),
  availableSlots: z.number().int().nonnegative(),
});

export type AgentConfig = {
  mtBaseUrl: string;
  agentKey: string;
  providerSlug: string;
  pollIntervalMs: number;
  listingIntervalMs: number;
  /** Local Proxmox the agent provisions against (creds NEVER leave the operator). */
  proxmox: { url?: string; tokenId?: string; tokenSecret?: string };
  /** Local Proxmox/node defaults the agent stamps into the arcane-mage YAML. */
  host: {
    network: string;
    storageImages: string;
    storageIso: string;
    storageImport: string;
    arcaneIso: string;
    sshPubkey: string;
    consoleHash: string;
  };
  /** Desired listing (price/capacity per tier); empty = don't re-assert. */
  listing: z.infer<typeof ListingTierConfig>[];
  /** When true (or Proxmox unconfigured), jobs are acknowledged without touching Proxmox. */
  dryRun: boolean;
};

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const proxmox = {
    url: env.PROXMOX_URL,
    tokenId: env.PROXMOX_TOKEN_ID,
    tokenSecret: env.PROXMOX_TOKEN_SECRET,
  };
  const dryRun = env.AGENT_DRY_RUN === "1" || !proxmox.url || !proxmox.tokenSecret;

  let listing: AgentConfig["listing"] = [];
  if (env.AGENT_LISTING_JSON) {
    listing = z.array(ListingTierConfig).parse(JSON.parse(env.AGENT_LISTING_JSON));
  }

  return {
    mtBaseUrl: req(env, "MT_BASE_URL").replace(/\/$/, ""),
    agentKey: req(env, "AGENT_KEY"),
    providerSlug: req(env, "PROVIDER_SLUG"),
    pollIntervalMs: Number(env.AGENT_POLL_INTERVAL_MS ?? 10_000),
    listingIntervalMs: Number(env.AGENT_LISTING_INTERVAL_MS ?? 60_000),
    proxmox,
    host: {
      network: env.PROXMOX_NETWORK ?? "vmbr0",
      storageImages: env.PROXMOX_STORAGE_IMAGES ?? "local-lvm",
      storageIso: env.PROXMOX_STORAGE_ISO ?? "local",
      storageImport: env.PROXMOX_STORAGE_IMPORT ?? "local",
      arcaneIso: env.ARCANE_ISO ?? "FluxLive.iso",
      sshPubkey: env.OPERATOR_SSH_PUBKEY ?? "",
      consoleHash: env.CONSOLE_PASSWORD_HASH ?? "!",
    },
    listing,
    dryRun,
  };
}
