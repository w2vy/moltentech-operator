import { readFileSync } from "node:fs";
import { z } from "zod";
import { TierKey, InventoryHost } from "@moltentech/protocol";

/** One tier's desired listing state, re-asserted to MT on a heartbeat. */
const ListingTierConfig = z.object({
  tier: TierKey,
  priceCents: z.number().int().positive(),
  capacity: z.number().int().nonnegative(),
  availableSlots: z.number().int().nonnegative(),
});

export type AgentConfig = {
  mtBaseUrl: string;
  /** Legacy per-provider bearer (agent → MT). Optional once MANIFEST_KEY is set. */
  agentKey?: string;
  /** base64 PKCS#8 PEM of the manifest ed25519 key; when set the agent SIGNS instead of bearer. */
  manifestKey?: string;
  /**
   * Self-pinned owner Flux/ZelID address (`1…` ZelID or `t1…` Flux). When set, the
   * agent refuses privileged jobs (delete/reprovision/move) without a matching owner
   * signature. Unset = enforcement off (pre-cutover behavior). NEVER sourced from MT.
   */
  ownerAddress?: string;
  providerSlug: string;
  pollIntervalMs: number;
  listingIntervalMs: number;
  healthIntervalMs: number;
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
  /** Declared agent-managed hosts + slots; empty = don't re-assert inventory. */
  inventory: InventoryHost[];
  /** Inventory source file, if any — re-read each heartbeat so console edits take effect. */
  inventoryPath?: string;
  /** The operator's own Coalition console base URL (WS3 courier); unset = no courier. */
  coalitionUrl?: string;
  /** When true (or Proxmox unconfigured), jobs are acknowledged without touching Proxmox. */
  dryRun: boolean;
};

/** Re-read the inventory file (if configured) so console edits propagate without a restart. */
export function reloadInventory(cfg: AgentConfig): InventoryHost[] {
  if (!cfg.inventoryPath) return cfg.inventory;
  try {
    return z.array(InventoryHost).parse(JSON.parse(readFileSync(cfg.inventoryPath, "utf8")));
  } catch (err) {
    console.error("[agent] inventory reload failed:", (err as Error).message);
    return cfg.inventory; // keep last-known-good on a transient read/parse error
  }
}

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

  // Inventory (agent-managed hosts + slots the operator declares to MT). Prefer a
  // local file (AGENT_INVENTORY_PATH, the operator's editable source of truth),
  // fall back to inline JSON; absent = don't re-assert.
  let inventory: AgentConfig["inventory"] = [];
  const inventoryRaw = env.AGENT_INVENTORY_PATH
    ? readFileSync(env.AGENT_INVENTORY_PATH, "utf8")
    : env.AGENT_INVENTORY_JSON;
  if (inventoryRaw) {
    inventory = z.array(InventoryHost).parse(JSON.parse(inventoryRaw));
  }

  // Auth: prefer asymmetric signing (MANIFEST_KEY) and fall back to the legacy
  // AGENT_KEY bearer; at least one must be present.
  const agentKey = env.AGENT_KEY || undefined;
  const manifestKey = env.MANIFEST_KEY || undefined;
  if (!agentKey && !manifestKey) {
    throw new Error("Missing agent auth: set MANIFEST_KEY (preferred) or AGENT_KEY");
  }

  return {
    mtBaseUrl: req(env, "MT_BASE_URL").replace(/\/$/, ""),
    agentKey,
    ownerAddress: env.OWNER_ADDRESS || undefined,
    manifestKey,
    providerSlug: req(env, "PROVIDER_SLUG"),
    pollIntervalMs: Number(env.AGENT_POLL_INTERVAL_MS ?? 10_000),
    listingIntervalMs: Number(env.AGENT_LISTING_INTERVAL_MS ?? 60_000),
    healthIntervalMs: Number(env.AGENT_HEALTH_INTERVAL_MS ?? 60_000),
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
    inventory,
    inventoryPath: env.AGENT_INVENTORY_PATH || undefined,
    coalitionUrl: env.COALITION_URL?.replace(/\/$/, "") || undefined,
    dryRun,
  };
}
