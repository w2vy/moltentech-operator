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
   * ⚠️ Not selling is expressed as an EMPTY price list, never as a tier priced at 0 —
   * MT enforces a per-tier floor (700 cents at the lowest) and 422s anything under it.
   */
  selling?: boolean;
  trialDays?: number;
  manualApproval?: boolean;
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

export function validateAnswers(a: Answers): string[] {
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
      if (TIER_FLOORS_CENTS[s.tier] == null) errs.push(`slot ${s.vmName}: unknown tier "${s.tier}".`);
      if (seenVmNames.has(s.vmName)) errs.push(`duplicate vmName "${s.vmName}".`);
      seenVmNames.add(s.vmName);
      if (!Number.isInteger(s.apiPort)) errs.push(`slot ${s.vmName}: apiPort must be an integer.`);
    }
  }

  for (const [tier, cents] of Object.entries(a.tierPricesCents ?? {})) {
    const floor = TIER_FLOORS_CENTS[tier];
    if (floor == null) errs.push(`price for unknown tier "${tier}".`);
    else if (!Number.isInteger(cents)) errs.push(`price for ${tier} must be integer cents.`);
    else if (cents < floor) errs.push(`price for ${tier} (${cents}) is below the platform floor ${floor}.`);
  }
  return errs;
}

/** Every tier actually in use, so prices default to the floor without being asked. */
export function tiersInUse(a: Answers): string[] {
  const set = new Set<string>();
  for (const h of a.hosts) for (const s of h.slots) set.add(s.tier);
  return [...set].sort();
}

export function resolvedPrices(a: Answers): Record<string, number> {
  const out: Record<string, number> = {};
  if (a.selling === false) return out;
  for (const tier of tiersInUse(a)) {
    // An unknown tier has no floor to fall back on; validateAnswers rejects it, and
    // defaulting to 0 here would quietly turn a typo into a free tier.
    const price = a.tierPricesCents?.[tier] ?? TIER_FLOORS_CENTS[tier];
    if (price != null) out[tier] = price;
  }
  return out;
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
    `OWNER_ADDRESS=${a.ownerAddress}`
  );
  if (a.mtPubkey) lines.push(`MT_PUBKEY=${a.mtPubkey}`);
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
export function renderSecretsEnv(a: Answers, opts: { includeStripe: boolean }): string {
  const lines = [
    "# secrets.env — generated by `mt-manifest init`. CONTAINS SECRETS once filled in.",
    "# Never commit this file. Never paste these values into config.env.",
    "#",
    "# Every value below is EMPTY on purpose: these are issued after this step.",
    "# Comments stay on their own line — text after `=` becomes part of the value.",
    "",
    "# MANIFEST_KEY — base64 of manifest-key.pem, issued by `mt-manifest keygen`.",
    "# Run the base64 yourself and paste the RESULT: env files run no shell, so",
    "# MANIFEST_KEY=$(base64 …) would ship literally.",
    "MANIFEST_KEY=",
    "",
    "# AGENT_KEY and COALITION_KEY — issued by the /onboard web flow after you sign.",
    "AGENT_KEY=",
    "COALITION_KEY=",
    "",
    "# SESSION_SECRET — any long random string (`openssl rand -hex 32`).",
    "# Without it the Coalition console withholds the node dashboard.",
    "SESSION_SECRET=",
  ];
  if (opts.includeStripe) {
    lines.push(
      "",
      "# Stripe — required because you listed at least one PAID tier.",
      "# STRIPE_SECRET_KEY: Stripe dashboard > Developers > API keys (use a restricted key).",
      "STRIPE_SECRET_KEY=",
      "# STRIPE_WEBHOOK_SECRET: shown ONCE when you create the webhook endpoint.",
      "# It is bound to THAT endpoint — a secret from a different endpoint fails silently",
      "# and checkout simply never completes.",
      "STRIPE_WEBHOOK_SECRET="
    );
  } else {
    lines.push(
      "",
      "# No Stripe keys needed: you are not listing anything for sale. Add a tier to",
      "# TIER_PRICES_JSON later and `mt-manifest env` will tell you what it then needs."
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderEnvOperator(
  a: Answers,
  proxmox: { url?: string; tokenId?: string; storageImport?: string; arcaneIso?: string } = {}
): string {
  const host = a.hosts[0];
  if (!host) throw new Error(".env.operator needs at least one host");
  const listing = Object.fromEntries(Object.entries(resolvedPrices(a)).map(([t, c]) => [t, c]));
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
    "# MANIFEST_KEY — the same base64 value as in secrets.env. Fill both.",
    "MANIFEST_KEY=",
    "",
    `PROXMOX_URL=${proxmox.url ?? `https://${host.nodeName ?? host.name}:8006`}`,
    `PROXMOX_TOKEN_ID=${proxmox.tokenId ?? ""}`,
    "PROXMOX_TOKEN_SECRET=",
    `PROXMOX_STORAGE_IMAGES=${host.storageImages}`,
    `PROXMOX_STORAGE_ISO=${host.storageIso}`,
    "# Scratch storage for image import; `local` suits almost every host.",
    `PROXMOX_STORAGE_IMPORT=${proxmox.storageImport ?? "local"}`,
    "",
    "# The bridge slot NICs attach to. The agent's built-in default is vmbr0 — wrong",
    "# on any host whose Flux traffic rides a VLAN bridge, and the VM then boots fine",
    "# and is reachable by nobody.",
    `PROXMOX_NETWORK=${host.network ?? "vmbr0"}`,
    "",
    "# ArcaneOS image name. `arcane-mage refresh-iso` keeps this current; the value",
    "# is versioned, so a stale name here fails the provision outright.",
    `ARCANE_ISO=${proxmox.arcaneIso ?? "FluxLive.iso"}`,
    "",
    "AGENT_INVENTORY_PATH=/data/inventory.json",
    `AGENT_LISTING_JSON=${JSON.stringify(listing)}`,
    "AGENT_DRY_RUN=false",
    "",
  ].join("\n");
}

/** inventory.json is a TOP-LEVEL ARRAY of hosts — matching the live known-good file. */
export function renderInventoryJson(a: Answers): string {
  const hosts = a.hosts.map((h) => ({
    name: h.name,
    nodeName: h.nodeName ?? h.name,
    // ⚠️ apiUrl points at the CLUSTER endpoint the agent talks to, which by convention
    // is the same host for every entry — not a self-pointing URL per host.
    apiUrl: `https://${h.nodeName ?? h.name}:8006`,
    storageImages: h.storageImages,
    storageIso: h.storageIso,
    slots: h.slots.map((s) => ({
      tier: s.tier,
      vmName: s.vmName,
      ipAddress: s.ipAddress,
      lanIp: s.lanIp,
      gateway: s.gateway,
      apiPort: s.apiPort,
    })),
  }));
  return JSON.stringify(hosts, null, 2) + "\n";
}

/** The Flux app spec. Every field already exists in the answers; hand-editing this
 * produced only JSON syntax errors on the pve30 run. */
export function renderFluxAppSpec(a: Answers): string {
  const spec = {
    version: 8,
    name: a.fluxAppName,
    description: `MoltenTech Coalition for ${a.providerName}`,
    owner: a.ownerAddress,
    compose: [
      {
        name: "coalition",
        description: "MoltenTech operator Coalition",
        repotag: "w2vy/coalition:latest",
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

export function generateAll(a: Answers): GeneratedFiles {
  const prices = resolvedPrices(a);
  return {
    "config.env": renderConfigEnv(a),
    "secrets.env": renderSecretsEnv(a, { includeStripe: hasPaidTier(prices) }),
    ".env.operator": renderEnvOperator(a),
    "inventory.json": renderInventoryJson(a),
    "flux-app-spec.json": renderFluxAppSpec(a),
  };
}
