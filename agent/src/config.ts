import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  TierKey,
  InventoryHost,
  FOUNDATION_VM_PREFIX,
  LoanOfferDeclaration,
} from "@moltentech/protocol";

/** One tier's desired listing state, re-asserted to MT on a heartbeat. */
const ListingTierConfig = z.object({
  tier: TierKey,
  priceCents: z.number().int().positive(),
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
  /**
   * VM-name prefix marking a node Flux Hub may DELETE without an owner signature.
   *
   * An eviction is machine-initiated — a customer buying a slot occupied by a free Foundation
   * node — so there is no human to sign it, and `delete` is a privileged action. The marking is
   * the VM's own name (`fh-mt-187-c3`) rather than a flag on the job, because a flag is written
   * by MT and the gate exists precisely to survive a compromised MT. A name is the identity of
   * the object on the hypervisor and is the same string `arcane-mage --vm-name` acts on, so a
   * delete permitted by this rule can destroy nothing except a VM actually named `fh-*`.
   *
   * Set to `""` to disable the exemption entirely — every delete then needs a signature, and
   * evictions on this operator's hardware simply fail.
   */
  foundationVmPrefix: string;
  providerSlug: string;
  pollIntervalMs: number;
  listingIntervalMs: number;
  healthIntervalMs: number;
  refreshIsoIntervalMs: number;
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
  /** Desired listing (price + slots offered per tier); empty = don't re-assert. */
  listing: z.infer<typeof ListingTierConfig>[];
  /** Declared agent-managed hosts + slots; empty = don't re-assert inventory. */
  inventory: InventoryHost[];
  /** Inventory source file, if any — re-read each heartbeat so console edits take effect. */
  inventoryPath?: string;
  /**
   * The lender's own loan-offer DECLARATIONS, if any (`AGENT_LOAN_OFFERS_PATH`). Unset = this
   * operator lends nothing, and both the offer build and the loan scan are no-ops.
   *
   * A LOCAL file, deliberately, and read the same way `inventory.json` is: the offer is the
   * lender operator's OWN declaration (prudent-lending-lamport §0.4 step 1), signed with the
   * agent's own key. Fetching it back from the hub would put MT on the path of a record MT has
   * no business holding — and the whole point of §9d.3 is to keep MT off that path.
   */
  loanOffersPath?: string;
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

/**
 * Re-read the loan-offer declarations each cycle, exactly as the inventory is re-read.
 *
 * Returns [] on a missing file or a bad parse, never a partial list: a set that half-loads would
 * let a live loan read as "no matching offer" and be refused, and a refusal means the lender
 * stops tracking a loan that is genuinely running. Last-known-good is not kept either — unlike
 * inventory, an offer the operator DELETED should stop being honoured, and the safe failure for
 * a scan that never deletes anything is to find no loan.
 */
export function reloadLoanOfferDeclarations(cfg: AgentConfig): LoanOfferDeclaration[] {
  if (!cfg.loanOffersPath) return [];
  try {
    return z
      .array(LoanOfferDeclaration)
      .parse(JSON.parse(readFileSync(cfg.loanOffersPath, "utf8")));
  } catch (err) {
    console.error("[loan] offer declarations reload failed:", (err as Error).message);
    return [];
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
    // `??` not `||`: an explicit empty string is a meaningful setting (exemption off), and
    // `||` would silently restore the default for the one operator who deliberately opted out.
    // Lowercased here so the comparison site never has to remember to — vmName becomes the guest
    // hostname, and hostnames get lowercased by convention.
    // Default comes from `protocol` so MT's decorator and this gate cannot drift apart — if they
    // did, MT would create VMs the agent refuses to delete and every eviction would fail.
    foundationVmPrefix: (env.FOUNDATION_VM_PREFIX ?? FOUNDATION_VM_PREFIX).toLowerCase(),
    manifestKey,
    providerSlug: req(env, "PROVIDER_SLUG"),
    pollIntervalMs: Number(env.AGENT_POLL_INTERVAL_MS ?? 10_000),
    listingIntervalMs: Number(env.AGENT_LISTING_INTERVAL_MS ?? 60_000),
    healthIntervalMs: Number(env.AGENT_HEALTH_INTERVAL_MS ?? 60_000),
    refreshIsoIntervalMs: Number(env.AGENT_REFRESH_ISO_INTERVAL_MS ?? 6 * 60 * 60_000),
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
    loanOffersPath: env.AGENT_LOAN_OFFERS_PATH || undefined,
    coalitionUrl: env.COALITION_URL?.replace(/\/$/, "") || undefined,
    dryRun,
  };
}
