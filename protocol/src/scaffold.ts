/**
 * scaffold — turn ~8 answers into the five files an operator would otherwise write
 * by hand, plus the Flux app spec.
 *
 * The premise, from the first from-zero onboarding: almost every failure was a human
 * transcribing a value from one file into another. Eight values are duplicated across
 * `config.env`, `secrets.env`, `.env.operator`, `inventory.json` and the app spec.
 * Generating all of them from ONE answer set deletes the transcription step, which is
 * a stronger fix than validating it afterwards.
 *
 * Pure functions over a plain `Answers` object: no prompts, no filesystem, no network.
 * The CLI supplies the answers (interactively or from `--answers answers.json`) and
 * writes what comes back — so the interactive and non-interactive paths run the exact
 * same generator, and the tests drive the same one the operator does.
 */

import { TIER_FLOORS_CENTS } from "./config-lint";

export interface SlotAnswer {
  tier: string;
  vmName: string;
  /** Public WAN IP the Flux node answers on. */
  ipAddress: string;
  /** LAN address WITH prefix — a bare IP silently becomes /32 and the node boots with
   * no gateway, so the CIDR is not optional and `init` refuses without it. */
  lanIp: string;
  gateway: string;
  apiPort: number;
  /** Bridge for THIS slot's NIC. Omitted = the host's `network`. Present so one
   * machine can carry slots on different bridges, which inventory could not express
   * while the value was written at host level only. */
  network?: string;
  /** Proxmox storage id for THIS slot's disk. Omitted = the host's `storageImages`. */
  storagePool?: string;
}

export interface HostAnswer {
  name: string;
  /** Proxmox node name; defaults to `name` when omitted. */
  nodeName?: string;
  /** Bridge the slot NICs attach to. The agent defaults to `vmbr0`, which is WRONG on
   * any host whose Flux traffic rides a VLAN bridge — and a VM on the wrong bridge
   * comes up looking fine and reachable by nobody. Emit it explicitly, always. */
  network?: string;
  /** ⚠️ Must resolve to a NON-rotational device. `mt-manifest` holds no Proxmox
   * credentials and cannot check that — `mt-agent doctor` does, where the creds are. */
  storageImages: string;
  storageIso: string;
  slots: SlotAnswer[];
}

export interface Answers {
  providerSlug: string;
  providerName: string;
  providerLocation?: string;
  providerContact?: string;
  ownerAddress: string;
  mtBaseUrl: string;
  /** Flux app name; the Coalition URL is DERIVED from it and never asked for. */
  fluxAppName: string;
  /** Optional pin of MT's own pubkey, as the runbook's config.env carries. */
  mtPubkey?: string;
  hosts: HostAnswer[];
  /** Tier → price in CENTS. Defaults to the platform floor for every tier in use. */
  tierPricesCents?: Record<string, number>;
  /**
   * Whether this operator sells to the public. `false` = a self-hoster running their
   * own nodes (and Foundation collateral): TIER_PRICES_JSON is written EMPTY and no
   * Stripe keys are scaffolded.
   *
   * ⚠️ Not selling is an EMPTY price list, never a tier priced at 0 — MT enforces a
   * per-tier minimum (`TierInfo.minPriceCents`, 700 at the lowest) and 422s anything
   * under it, so a 0 is not expressible.
   *
   * ⚠️ This is NOT what a "free rental" is. That is a rental an admin ASSIGNS to a
   * customer (or to themselves); it carries a synthetic `free-<slotId>-<ts>`
   * subscription id and is unrelated to what any tier costs. An operator can receive
   * assigned rentals with no Stripe account and no listing at all.
   */
  selling?: boolean;
  /**
   * Which kind of participant this is (see `ProviderManifestBody.level`).
   *
   *   supporter — runs their own nodes, lends idle capacity for Foundation nodes,
   *               sells nothing, needs no Stripe account
   *   operator  — also rents hardware out through the marketplace
   *
   * `selling` is DERIVED from this when it is not stated, so the two cannot disagree.
   * Kept separate rather than collapsed into one field because they answer different
   * questions: `level` is what you signed up as and is published in the manifest;
   * `selling` is whether this particular scaffold lists anything, which a supporter
   * who later adds a tier can change without re-declaring who they are.
   */
  level?: "supporter" | "operator";
  /**
   * Tier → how many slots to OFFER for sale. Defaults to every slot of that tier in
   * `hosts`, which is what an operator almost always means.
   *
   * It is a throttle, never a capacity claim: MT clamps it to the live count of
   * `available` Slot rows (`ListingTier` in messages.ts), so an operator can offer
   * fewer than they have and never more. Hold slots back by listing a smaller number.
   */
  availableSlots?: Record<string, number>;
  trialDays?: number;
  manualApproval?: boolean;
  /**
   * Proxmox API token, as `pveum user token add` printed it in Step 0.1 — the id
   * (`fluxhub@pve!agent`) and the secret shown exactly once.
   *
   * Carried through `Answers` rather than asked for only at the prompt so the
   * `--answers` path writes the same complete files the interactive one does. That
   * split is what shipped `MT_PUBKEY=` empty for every scripted onboarding
   * (operator#54); it is not repeated here.
   */
  /** Base URL of the Proxmox API, e.g. `https://192.168.1.10:8006`. An IP beats a
   * hostname: `mt-manifest` and the agent both run in containers, which resolve names
   * themselves and often cannot see the LAN's DNS. */
  proxmoxUrl?: string;
  proxmoxTokenId?: string;
  proxmoxTokenSecret?: string;
  /** Stripe restricted key + webhook signing secret. Only ever asked of an operator
   * who listed a paid tier; a self-hoster has no Stripe account to ask about. */
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  /**
   * The Coalition console's session secret. Any long random string — it has no
   * external issuer, so `init` GENERATES one when this is absent rather than sending
   * the operator away to run `openssl rand -hex 32`. Present here so a re-run with
   * `--answers` can keep a console's existing sessions alive.
   */
  sessionSecret?: string;
}

/** The Flux app URL is deterministic and documented nowhere else. Deriving it is what
 * resolves the COALITION_URL circularity: choose the app name, derive the URL, sign,
 * then deploy — instead of needing the URL before the app exists. */
export function coalitionUrlFor(fluxAppName: string): string {
  return `https://${fluxAppName}.app.runonflux.io`;
}

/** Fold the slug into the app name, so choosing one validates the other. */
export function suggestFluxAppName(providerSlug: string): string {
  return `coalition-${providerSlug}`;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function validateAnswers(
  a: Answers,
  minimums: Record<string, number> = TIER_FLOORS_CENTS
): string[] {
  const errs: string[] = [];
  if (!SLUG_RE.test(a.providerSlug)) {
    errs.push(
      `providerSlug "${a.providerSlug}" must match ${SLUG_RE} — it is PERMANENT, pinned at first ingest.`
    );
  }
  if (!a.providerName) errs.push("providerName is required.");
  if (!a.ownerAddress) errs.push("ownerAddress is required — it is baked into the bytes signed at /onboard.");
  if (!/^https:\/\//.test(a.mtBaseUrl)) errs.push(`mtBaseUrl "${a.mtBaseUrl}" must be an https URL.`);
  if (!a.fluxAppName) errs.push("fluxAppName is required (the Coalition URL derives from it).");
  if (a.hosts.length === 0) errs.push("at least one Proxmox host is required.");

  const seenVmNames = new Set<string>();
  for (const h of a.hosts) {
    if (!h.name) errs.push("every host needs a name.");
    if (!h.storageImages) errs.push(`host ${h.name}: storageImages is required.`);
    for (const s of h.slots) {
      if (!/\/\d{1,2}$/.test(s.lanIp)) {
        errs.push(`slot ${s.vmName}: lanIp "${s.lanIp}" needs a /NN suffix, or the node boots with no gateway.`);
      }
      if (minimums[s.tier] == null) errs.push(`slot ${s.vmName}: unknown tier "${s.tier}".`);
      if (seenVmNames.has(s.vmName)) errs.push(`duplicate vmName "${s.vmName}".`);
      seenVmNames.add(s.vmName);
      if (!Number.isInteger(s.apiPort)) errs.push(`slot ${s.vmName}: apiPort must be an integer.`);
    }
  }

  const counts = slotCountsByTier(a);
  for (const [tier, offered] of Object.entries(a.availableSlots ?? {})) {
    if (counts[tier] == null) {
      errs.push(`availableSlots names tier "${tier}", which no slot uses.`);
    } else if (!Number.isInteger(offered) || offered < 0) {
      errs.push(`availableSlots for ${tier} must be a whole number of slots.`);
    } else if (offered > counts[tier]!) {
      // MT clamps this down anyway, so it cannot oversell — but a number above the
      // count means the operator believes they declared hardware they did not.
      errs.push(
        `availableSlots for ${tier} (${offered}) is more than the ${counts[tier]} ${tier} slot(s) declared.`
      );
    }
  }

  for (const [tier, cents] of Object.entries(a.tierPricesCents ?? {})) {
    const floor = minimums[tier];
    if (floor == null) errs.push(`price for unknown tier "${tier}".`);
    else if (!Number.isInteger(cents)) errs.push(`price for ${tier} must be integer cents.`);
    else if (cents < floor) errs.push(`price for ${tier} (${cents}) is below the platform minimum ${floor}.`);
  }
  return errs;
}

/**
 * Does `init` still need to derive MT's signing pubkey, or did the operator pin one?
 *
 * An explicitly supplied `mtPubkey` always wins — someone pinning it by hand (an
 * air-gapped run, or deliberately holding an older key) must not have it silently
 * overwritten by whatever the live endpoint happens to serve.
 *
 * Kept here rather than in the CLI so BOTH init paths — the wizard and
 * `--answers` — ask the same question of the same object. Deriving it inside the
 * interactive prompts is exactly how the `--answers` path came to skip it entirely.
 */
export function needsMtPubkey(a: Answers): boolean {
  return (a.mtPubkey ?? "").trim() === "";
}

/** Every tier actually in use, so prices default to the floor without being asked. */
export function tiersInUse(a: Answers): string[] {
  const set = new Set<string>();
  for (const h of a.hosts) for (const s of h.slots) set.add(s.tier);
  return [...set].sort();
}

export function resolvedPrices(a: Answers): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isSelling(a)) return out;
  for (const tier of tiersInUse(a)) {
    // An unknown tier has no floor to fall back on; validateAnswers rejects it, and
    // defaulting to 0 here would quietly produce an unlistable price.
    const price = a.tierPricesCents?.[tier] ?? TIER_FLOORS_CENTS[tier];
    if (price != null) out[tier] = price;
  }
  return out;
}

/** How many slots of each tier the answers actually declare. */
export function slotCountsByTier(a: Answers): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const h of a.hosts) for (const s of h.slots) counts[s.tier] = (counts[s.tier] ?? 0) + 1;
  return counts;
}

/**
 * `AGENT_LISTING_JSON` — an ARRAY of `{tier, priceCents, availableSlots}`, which is
 * what the agent parses (`z.array(ListingTierConfig)` in agent/src/config.ts).
 *
 * The defect this replaces: `init` wrote the `TIER_PRICES_JSON` MAP here verbatim, so
 * every operator's agent died at startup with `ZodError: Expected array, received
 * object` — before it could assert anything, so nothing downstream even hinted why.
 *
 * `availableSlots` is derived rather than asked: `init` already knows the slots, and
 * offering all of them is the answer almost every operator wants. Listing fewer is the
 * only case that needs an explicit number.
 */
export function resolvedListing(
  a: Answers
): Array<{ tier: string; priceCents: number; availableSlots: number }> {
  const counts = slotCountsByTier(a);
  return Object.entries(resolvedPrices(a)).map(([tier, priceCents]) => ({
    tier,
    priceCents,
    availableSlots: a.availableSlots?.[tier] ?? counts[tier] ?? 0,
  }));
}

/**
 * Does this operator sell? Explicit `selling` wins; otherwise a Supporter sells nothing
 * and everyone else does. One place, so the price list, the Stripe scaffolding and the
 * doctor's warnings can never disagree about it.
 */
export function isSelling(a: Answers): boolean {
  if (typeof a.selling === "boolean") return a.selling;
  return a.level !== "supporter";
}

/** Whether anything is listed for sale — the gate for whether Stripe is needed.
 * Any listed tier is a paid tier, because every price must clear the platform floor. */
export function hasPaidTier(prices: Record<string, number>): boolean {
  return Object.keys(prices).length > 0;
}

export function renderConfigEnv(a: Answers): string {
  const lines = [
    "# config.env — generated by `mt-manifest init`. NON-SECRET: no keys, no tokens.",
    "# Comments live on their own line: everything after `=` is part of the value.",
    "",
    `PROVIDER_SLUG=${a.providerSlug}`,
    `PROVIDER_NAME=${a.providerName}`,
  ];
  if (a.providerLocation) lines.push(`PROVIDER_LOCATION=${a.providerLocation}`);
  if (a.providerContact) lines.push(`PROVIDER_CONTACT=${a.providerContact}`);
  lines.push(
    `MT_BASE_URL=${a.mtBaseUrl}`,
    `COALITION_URL=${coalitionUrlFor(a.fluxAppName)}`,
    `OWNER_ADDRESS=${a.ownerAddress}`,
    "",
    "# PROVIDER_LEVEL — what you signed up as, published in your signed manifest.",
    "#   supporter = your own nodes + Foundation nodes on idle capacity; nothing for sale",
    "#   operator  = the above, plus hardware rented out through the marketplace",
    "# A supporter needs no Stripe account at all.",
    `PROVIDER_LEVEL=${a.level ?? (isSelling(a) ? "operator" : "supporter")}`
  );
  // ALWAYS emitted, even empty. An absent line is invisible: the operator has nothing
  // to notice and nothing to fill in, and the omission only surfaces at the first
  // customer checkout, as a 401 from their own Coalition.
  lines.push(
    "# MT_PUBKEY — the Coalition pins this to verify MT's inbound checkout/manage calls.",
    "# Derived from {MT_BASE_URL}/api/mt-pubkey at init. If it is EMPTY below, fill it in",
    "# by hand before deploying: an empty value means checkout returns 401 forever, and",
    "# nothing else in onboarding will tell you. It is per-MT — moving a Coalition between",
    "# instances needs this changed as well as MT_BASE_URL (neither is in the signed",
    "# manifest, so changing both needs no re-sign).",
    `MT_PUBKEY=${a.mtPubkey ?? ""}`
  );
  lines.push(
    `HOSTS=${a.hosts.map((h) => h.name).join(",")}`,
    `TIER_PRICES_JSON=${JSON.stringify(resolvedPrices(a))}`,
    `TRIAL_DAYS=${a.trialDays ?? 1}`,
    `MANUAL_APPROVAL=${a.manualApproval ? "true" : "false"}`,
    ""
  );
  return lines.join("\n");
}

/**
 * The secrets skeleton — empty values, every comment on its OWN line.
 *
 * ⚠️ The own-line rule is correctness, not style: everything after `=` is the value,
 * so a trailing `# note` silently becomes part of the secret and surfaces far away as
 * a bare 401. Generating the file is also what stops an operator inventing their own
 * layout, which is where a live Proxmox token once landed in the non-secret file.
 *
 * Empty-but-present is a deliberate third state — `doctor` reports it as "not yet
 * filled", never as an error, so a fresh scaffold does not read as broken.
 */
/**
 * `secrets.env` — the Coalition's secret environment.
 *
 * ⚠️ An EMPTY value here must mean "another system has to issue this", never "we did
 * not bother to ask". A real onboarding run (2026-08-22) ended with ten
 * `NOT_YET_FILLED` warnings of which seven were values `init` already held or could
 * have asked for — and a warning list that is mostly noise is one the operator learns
 * to skim, which is where the three that matter then hide.
 *
 * So: MANIFEST_KEY is derived from the key on disk, SESSION_SECRET is generated, the
 * Stripe pair is asked for, and exactly three values are left empty — the ones the
 * `/onboard` web flow mints and shows once.
 */
export function renderSecretsEnv(
  a: Answers,
  opts: {
    includeStripe: boolean;
    /** base64 of manifest-key.pem, derived by the CLI from the key `init` requires. */
    manifestKey?: string;
    /** Generated by the CLI when the operator did not supply one. */
    sessionSecret?: string;
  }
): string {
  const lines = [
    "# secrets.env — generated by `mt-manifest init`. CONTAINS SECRETS.",
    "# Never commit this file. Never paste these values into config.env.",
    "#",
    "# The values still EMPTY below are the ones another system has to issue; each",
    "# names its source. Everything else was filled in from your answers.",
    "# Comments stay on their own line — text after `=` becomes part of the value.",
    "",
    "# MANIFEST_KEY — base64 of manifest-key.pem, filled in by `mt-manifest init`.",
    "# Never a shell substitution: env files run no shell, so MANIFEST_KEY=$(base64 …)",
    "# would ship literally.",
    `MANIFEST_KEY=${opts.manifestKey ?? ""}`,
    "",
    "# AGENT_KEY, COALITION_KEY and COALITION_SIGNING_KEY — all three are issued by the",
    "# /onboard web flow after you sign, and shown ONCE. COALITION_SIGNING_KEY has no",
    "# consumer today (it signs your Coalition's reports to MT from Phase D on), but it",
    "# is only ever displayed on that page: store it now or it is gone.",
    "AGENT_KEY=",
    "COALITION_KEY=",
    "COALITION_SIGNING_KEY=",
    "",
    "# SESSION_SECRET — generated for you (32 random bytes, hex). It has no external",
    "# issuer, so there is nothing to wait for. Without it the Coalition console",
    "# withholds the node dashboard. Changing it logs everyone out; that is all.",
    `SESSION_SECRET=${opts.sessionSecret ?? ""}`,
  ];
  if (opts.includeStripe) {
    lines.push(
      "",
      "# Stripe — required because you listed at least one PAID tier.",
      "# STRIPE_SECRET_KEY: Stripe dashboard > Developers > API keys (use a restricted key).",
      `STRIPE_SECRET_KEY=${a.stripeSecretKey ?? ""}`,
      "# STRIPE_WEBHOOK_SECRET: shown ONCE when you create the webhook endpoint.",
      "# It is bound to THAT endpoint — a secret from a different endpoint fails silently",
      "# and checkout simply never completes. Empty until you create the endpoint, which",
      "# needs the Coalition URL above — that is a real wait, not a missing question.",
      `STRIPE_WEBHOOK_SECRET=${a.stripeWebhookSecret ?? ""}`
    );
  } else {
    lines.push(
      "",
      "# No Stripe keys needed: you are not listing anything for sale. Add a tier to",
      "# TIER_PRICES_JSON later and `mt-manifest env` will tell you what it then needs.",
      "#",
      "# You can still run nodes: a rental an admin ASSIGNS to you needs no payment",
      "# method at all. Stripe is what lets STRANGERS buy from you."
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderEnvOperator(
  a: Answers,
  proxmox: {
    url?: string;
    tokenId?: string;
    storageImport?: string;
    arcaneIso?: string;
    /** Base64 pubkey from `manifest-pubkey.txt`, when keygen has already run. */
    manifestPubkey?: string;
    /** base64 of manifest-key.pem — the SAME value secrets.env carries. The agent
     * and the Coalition each read their own env file, so this is genuinely two
     * copies of one secret, not a duplicate to be deduplicated away. */
    manifestKey?: string;
    /** The `pveum user token add` secret, printed once in Step 0.1. */
    tokenSecret?: string;
  } = {}
): string {
  const host = a.hosts[0];
  if (!host) throw new Error(".env.operator needs at least one host");
  return [
    "# .env.operator — generated by `mt-manifest init`. The AGENT's environment.",
    "# Holds Proxmox credentials by design; still never commit it.",
    "",
    `PROVIDER_SLUG=${a.providerSlug}`,
    `MT_BASE_URL=${a.mtBaseUrl}`,
    `OWNER_ADDRESS=${a.ownerAddress}`,
    "",
    "# COALITION_URL is what turns the courier ON. Unset, the agent logs `courier=off`",
    "# once and no authorization request ever reaches you.",
    `COALITION_URL=${coalitionUrlFor(a.fluxAppName)}`,
    "",
    "# MANIFEST_KEY — the same base64 value as in secrets.env; `init` fills both from",
    "# the key on disk. Empty here means the agent signs nothing and runs courier=off.",
    `MANIFEST_KEY=${proxmox.manifestKey ?? ""}`,
    "",
    "# MANIFEST_PUBKEY — the public half, from manifest-pubkey.txt (`mt-manifest keygen`).",
    "# It is NOT a second secret: it is the pin `mt-agent doctor` compares MANIFEST_KEY",
    "# against. Left empty, that check can only report `skip` — so the one failure it",
    "# exists to catch (the agent loaded a DIFFERENT key from the one MT pinned at first",
    "# ingest) stays invisible until the hub rejects a signature. `keygen` fills this in",
    "# if .env.operator already exists.",
    `MANIFEST_PUBKEY=${proxmox.manifestPubkey ?? ""}`,
    "",
    `PROXMOX_URL=${proxmox.url ?? `https://${host.nodeName ?? host.name}:8006`}`,
    `PROXMOX_TOKEN_ID=${proxmox.tokenId ?? ""}`,
    `PROXMOX_TOKEN_SECRET=${proxmox.tokenSecret ?? ""}`,
    `PROXMOX_STORAGE_IMAGES=${host.storageImages}`,
    `PROXMOX_STORAGE_ISO=${host.storageIso}`,
    "# Scratch storage for image import; `local` suits almost every host.",
    `PROXMOX_STORAGE_IMPORT=${proxmox.storageImport ?? "local"}`,
    "",
    "# The bridge slot NICs attach to. The agent's built-in default is vmbr0 — wrong",
    "# on any host whose Flux traffic rides a VLAN bridge, and the VM then boots fine",
    "# and is reachable by nobody.",
    `PROXMOX_NETWORK=${host.network ?? DEFAULT_NETWORK}`,
    "",
    "# ArcaneOS image name. `arcane-mage refresh-iso` keeps this current; the value",
    "# is versioned, so a stale name here fails the provision outright.",
    `ARCANE_ISO=${proxmox.arcaneIso ?? "FluxLive.iso"}`,
    "",
    "AGENT_INVENTORY_PATH=/data/inventory.json",
    "",
    "# What is FOR SALE: an array of {tier, priceCents, availableSlots}. `availableSlots`",
    "# is a throttle, not a capacity claim — MT clamps it to your live available slots, so",
    "# you can offer fewer than you have and never more. Prices here and TIER_PRICES_JSON",
    "# in config.env must agree, or the Coalition and MT quote different numbers.",
    `AGENT_LISTING_JSON=${JSON.stringify(resolvedListing(a))}`,
    "AGENT_DRY_RUN=false",
    "",
  ].join("\n");
}

/** What `fillManifestPubkey` did, so the caller can say so honestly. */
export type PubkeyFillResult = "filled" | "already-set";

/**
 * Put the manifest pubkey into an existing `.env.operator`, without disturbing
 * anything else in it. Pure string in, string out — the CLI owns the file IO.
 *
 * NEVER overwrites a non-empty value. A pinned pubkey that no longer matches the key
 * in use is a real finding for `mt-agent doctor` to report; quietly rewriting it to
 * match whatever key was just generated would delete the evidence and turn a rotation
 * into a silent identity change.
 */
export function fillManifestPubkey(
  envOperator: string,
  pubkey: string
): { text: string; result: PubkeyFillResult } {
  const line = /^MANIFEST_PUBKEY=(.*)$/m;
  const found = envOperator.match(line);
  if (found) {
    if (found[1]!.trim()) return { text: envOperator, result: "already-set" };
    return { text: envOperator.replace(line, `MANIFEST_PUBKEY=${pubkey}`), result: "filled" };
  }
  // Written by an older `init`, which emitted no slot at all. Append one WITH its
  // comment: an operator who later reads the file should find the same explanation a
  // freshly generated file carries.
  const suffix =
    (envOperator.endsWith("\n") ? "" : "\n") +
    [
      "",
      "# MANIFEST_PUBKEY — the public half, from manifest-pubkey.txt (`mt-manifest keygen`).",
      "# `mt-agent doctor` compares MANIFEST_KEY against it; empty means that check can",
      "# only report `skip`.",
      `MANIFEST_PUBKEY=${pubkey}`,
      "",
    ].join("\n");
  return { text: envOperator + suffix, result: "filled" };
}

/**
 * The LAN a host's VMs live on, given as ONE answer: the gateway with its prefix,
 * `192.168.87.1/24`.
 *
 * Asking for gateway and prefix separately is how `lanIp` ends up without a `/NN` — and
 * a bare lanIp silently becomes /32, so the node boots with no route out and is
 * reachable by nobody. `doctor` catches that after the fact; taking the prefix from the
 * gateway answer means a slot cannot be written without one in the first place.
 */
export interface LanNetwork {
  /** The gateway address itself, e.g. `192.168.87.1`. */
  gateway: string;
  /** Prefix length, e.g. 24. */
  prefix: number;
  /** The first three octets, e.g. `192.168.87.` — what a host number is appended to. */
  base: string;
}

export function parseLanNetwork(input: string): LanNetwork {
  const m = input.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) throw new Error(`expected a gateway with prefix, e.g. 192.168.87.1/24 — got "${input}"`);
  const [, gateway, prefixStr] = m;
  const octets = gateway!.split(".").map(Number);
  if (octets.some((o) => o > 255)) throw new Error(`"${gateway}" is not a valid IPv4 address`);
  const prefix = Number(prefixStr);
  if (prefix < 8 || prefix > 30) throw new Error(`prefix /${prefix} is not usable for a VM LAN`);
  return { gateway: gateway!, prefix, base: octets.slice(0, 3).join(".") + "." };
}

/**
 * Turn what the operator typed for a slot into a full `lanIp`. A bare host number (`5`)
 * is completed from the gateway's own /24-style base; a full address is kept. The prefix
 * is ALWAYS appended, which is the entire point.
 */
export function slotLanIp(input: string, net: LanNetwork): string {
  const raw = input.trim().replace(/\/\d{1,2}$/, "");
  const address = /^\d{1,3}$/.test(raw) ? `${net.base}${raw}` : raw;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    throw new Error(`"${input}" is neither a host number nor an IPv4 address`);
  }
  return `${address}/${net.prefix}`;
}

/** The Flux API port every node answers on. Ports are allocated from a base by index so
 * an operator does not invent 31 of them by hand, and so the block they have to open in
 * the firewall is contiguous and predictable. */
export const DEFAULT_API_PORT = 16127;

/**
 * Ports go up in tens. Measured against the live fleet (prod `Slot.apiPort`, 2026-08-22):
 * 16127, 16137, 16147 … 16197 — Flux uses a small block of consecutive ports per node
 * (api, api-ssl, p2p …), so consecutive node ports would collide.
 */
export const API_PORT_STRIDE = 10;

export function allocateApiPort(base: number, index: number): number {
  return base + index * API_PORT_STRIDE;
}

/**
 * The LAST port in the block: 16127, 16137 … 16197, and no further.
 *
 * This is not a style choice — it is the reason a WAN IP tops out at eight slots
 * ([[project_flux_wan_ip_expansion]]). Flux takes a small block of consecutive ports per
 * node from its own base, so the ninth node behind one public IP has nowhere to go; more
 * capacity means another WAN IP, not another port.
 */
export const MAX_API_PORT = 16197;

/** Ports are per WAN IP, so every WAN IP starts again at the base. Two nodes on 16127 is
 * only a collision when they share a public address. */
export const API_PORTS_PER_WAN = (MAX_API_PORT - DEFAULT_API_PORT) / API_PORT_STRIDE + 1;

/**
 * Is this a port Flux will actually serve on? In range, and on the stride — which is the
 * same as saying it ends in 7. A port off the stride overlaps the previous node's block
 * and fails as *that* node going unreachable, not as an error about the port typed here.
 */
export function isFluxApiPort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= DEFAULT_API_PORT &&
    port <= MAX_API_PORT &&
    (port - DEFAULT_API_PORT) % API_PORT_STRIDE === 0
  );
}

/** The agent's own fallback when nothing is declared (`agent/src/config.ts`). Written
 * out explicitly rather than relied on, so the value is visible in the file. */
export const DEFAULT_NETWORK = "vmbr0";

/** The bridge a slot actually provisions onto: `slot.network ?? host.network`, the
 * same precedence `agent/src/executor.ts` applies. */
export function slotNetwork(h: HostAnswer, s: SlotAnswer): string {
  return s.network ?? h.network ?? DEFAULT_NETWORK;
}

/** The storage id a slot actually provisions onto: `slot.storagePool ?? host.storageImages`. */
export function slotStoragePool(h: HostAnswer, s: SlotAnswer): string {
  return s.storagePool ?? h.storageImages;
}

/**
 * inventory.json is a TOP-LEVEL ARRAY of hosts — matching the live known-good file.
 *
 * ⚠️ `network` and `storagePool` are emitted on every SLOT as well as the host.
 * MT's ingest materializes Slot rows from the per-slot fields only
 * (`protocol/src/messages.ts` `InventorySlot`), so a host-level-only value produced
 * Slot rows with EMPTY `storagePool` and `network` — silently, since `doctor` passes
 * by checking the host-level value that was written. Provisioning agrees: the agent
 * builds its YAML from `slot.storagePool ?? host.storageImages` and
 * `slot.network ?? host.network`. Writing both levels makes the DB, the provision and
 * the file say the same thing.
 */
export function renderInventoryJson(a: Answers): string {
  const hosts = a.hosts.map((h) => ({
    name: h.name,
    nodeName: h.nodeName ?? h.name,
    // ⚠️ apiUrl points at the CLUSTER endpoint the agent talks to, which by convention
    // is the same host for every entry — not a self-pointing URL per host.
    apiUrl: `https://${h.nodeName ?? h.name}:8006`,
    network: h.network ?? DEFAULT_NETWORK,
    storageImages: h.storageImages,
    storageIso: h.storageIso,
    slots: h.slots.map((s) => ({
      tier: s.tier,
      vmName: s.vmName,
      ipAddress: s.ipAddress,
      lanIp: s.lanIp,
      gateway: s.gateway,
      apiPort: s.apiPort,
      network: slotNetwork(h, s),
      storagePool: slotStoragePool(h, s),
    })),
  }));
  return JSON.stringify(hosts, null, 2) + "\n";
}

/**
 * The Coalition image the generated Flux app spec deploys, PINNED.
 *
 * `:latest` deploys correctly today and breaks reproducibility invisibly: a Flux app
 * spec is a signed, on-chain artifact, so two operators registering "the same" spec
 * weeks apart get different code with nothing recording that they differ. The doc
 * pins for the same reason (docs/operator-onboarding.md, #49) — this is that decision
 * applied to the generator, and `scaffold.test.ts` fails if the two drift apart.
 *
 * Bump this WITH the doc when a new Coalition version is published.
 */
export const COALITION_IMAGE = "w2vy/coalition:0.2.8";

/** The Flux app spec. Every field already exists in the answers; hand-editing this
 * produced only JSON syntax errors on the pve30 run.
 *
 * ⚠️ **`owner` is deliberately ABSENT.** It is not `OWNER_ADDRESS`: that is the wallet
 * that signs the MT manifest attestation, while a Flux app is owned by the **ZelID** the
 * operator registers from — a different identity, and one this generator cannot know.
 * FluxOS supplies it: `RegisterFluxApp.vue` assigns
 * `appRegistrationSpecification.owner = auth.zelid` both on mount and after a spec is
 * loaded, so an imported value is overwritten by the logged-in ZelID either way.
 * Emitting `OWNER_ADDRESS` here produced a field that looked authoritative, was wrong,
 * and was then silently ignored — the worst of the three.
 *
 * Note this holds for the UI registration path the runbook describes. The network layer
 * still REQUIRES an owner (`appsService.js` rejects a non-string, and the broadcast
 * signature is verified against `appSpec.owner`), so anyone registering through the API
 * directly must supply their own.
 */
export function renderFluxAppSpec(a: Answers): string {
  const spec = {
    version: 8,
    name: a.fluxAppName,
    description: `MoltenTech Coalition for ${a.providerName}`,
    compose: [
      {
        name: "coalition",
        description: "MoltenTech operator Coalition",
        repotag: COALITION_IMAGE,
        ports: [33001],
        domains: [""],
        environmentParameters: [] as string[],
        commands: [] as string[],
        containerPorts: [8088],
        containerData: "/data",
        cpu: 0.5,
        ram: 1000,
        hdd: 5,
        tiered: false,
      },
    ],
    instances: 3,
    contacts: a.providerContact ? [a.providerContact] : [],
    geolocation: [] as string[],
    expire: 22000,
    nodes: [] as string[],
    staticip: false,
  };
  return JSON.stringify(spec, null, 2) + "\n";
}

export interface GeneratedFiles {
  "config.env": string;
  "secrets.env": string;
  ".env.operator": string;
  "inventory.json": string;
  "flux-app-spec.json": string;
}

export function generateAll(
  a: Answers,
  opts: {
    manifestPubkey?: string;
    /** base64 of manifest-key.pem. The CLI derives it; the generator stays pure so
     * both `init` paths and the tests produce byte-identical files from one input. */
    manifestKey?: string;
    /** Randomness is the CLI's job for the same reason — a generator that reaches for
     * `randomBytes` cannot be diffed against itself. */
    sessionSecret?: string;
  } = {}
): GeneratedFiles {
  const prices = resolvedPrices(a);
  return {
    "config.env": renderConfigEnv(a),
    "secrets.env": renderSecretsEnv(a, {
      includeStripe: hasPaidTier(prices),
      manifestKey: opts.manifestKey,
      sessionSecret: opts.sessionSecret,
    }),
    ".env.operator": renderEnvOperator(a, {
      manifestPubkey: opts.manifestPubkey,
      manifestKey: opts.manifestKey,
      url: a.proxmoxUrl,
      tokenId: a.proxmoxTokenId,
      tokenSecret: a.proxmoxTokenSecret,
    }),
    "inventory.json": renderInventoryJson(a),
    "flux-app-spec.json": renderFluxAppSpec(a),
  };
}
