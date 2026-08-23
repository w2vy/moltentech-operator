/**
 * config-lint — the onboarding consistency table, executed.
 *
 * The rewritten runbook (`docs/operator-onboarding.md`) documents "which value must
 * match where" across the five files an operator writes. That table is a validation
 * spec nobody runs, and every snag from the first from-zero onboarding (pve30 onto
 * staging, 2026-08-08) was either a value transcribed wrong between two of those
 * files or a default that is wrong on real hardware.
 *
 * Every rule here is a pure function over file TEXT — no network, no secrets held,
 * no Proxmox credentials (`mt-manifest` is deliberately secret-free; the checks that
 * need creds live in `mt-agent doctor` instead). That purity is what makes the whole
 * rule set unit-testable from fixture strings.
 *
 * Ordering principle, from the run: rank by what fails SILENTLY. A 422 or a 409
 * announces itself and costs seconds; a VM quietly landing on a spinning disk, or a
 * courier quietly never starting, costs a whole provision cycle and a beginner
 * cannot diagnose either. The silent rules are the reason this file exists.
 */
import { renderManifestBodyFromConfig } from "./manifest-config";
import { canonicalize, verifyManifestObject } from "./signing";


/** The lowest price, in CENTS, MT will accept for a listed tier — **FALLBACK ONLY**.
 *
 * The live values come from `GET /api/tiers` on the hub (`fetchTierMinimums` below);
 * this table is what we use when that call cannot be made — offline, MT down, or no
 * `MT_BASE_URL` known yet. Treat it as a cache, not a second source of truth: if it
 * disagrees with the API, the API wins and the operator is told which was used.
 *
 * ⚠️ Source of truth is `TierInfo.minPriceCents` in `apps/web/src/lib/tiers.ts` (hub
 * repo, which this repo cannot import). Do NOT confuse it with `TierInfo.price`,
 * MoltenTech's own list price — they were one field until 2026-08-11, which meant a
 * change to what MT charged silently moved what operators were allowed to charge.
 *
 * ⚠️ The operator CI asserts this table still equals the live API, so drift fails a
 * build instead of silently blessing a price MT will 422.
 */
export const TIER_FLOORS_CENTS: Record<string, number> = {
  cumulus: 700,
  nimbus: 2000,
  stratus: 4000,
};

export interface TierCatalogEntry {
  key: string;
  name?: string;
  minPriceCents: number;
  listPriceCents?: number;
}

/**
 * Fetch the live tier minimums from the hub.
 *
 * Returns `null` on any failure — unreachable, non-200, malformed — because a wizard
 * that cannot reach MT must still be able to scaffold. The caller falls back to
 * `TIER_FLOORS_CENTS` and says so, rather than either failing outright or pretending
 * the stale numbers came from the API.
 */
export async function fetchTierMinimums(
  mtBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000
): Promise<Record<string, number> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${mtBaseUrl.replace(/\/$/, "")}/api/tiers`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tiers?: TierCatalogEntry[] };
    if (!Array.isArray(body?.tiers) || body.tiers.length === 0) return null;
    const out: Record<string, number> = {};
    for (const t of body.tiers) {
      if (typeof t?.key !== "string" || !Number.isInteger(t?.minPriceCents)) return null;
      out[t.key] = t.minPriceCents;
    }
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A price this far above the floor is a misplaced zero, not a pricing decision. */
const PRICE_SANITY_MULTIPLE = 5;

export interface EnvEntry {
  key: string;
  value: string;
  /** 1-indexed line number in the source file, so findings can point at it. */
  line: number;
}

export type Severity = "error" | "warning";

export interface Finding {
  /** Stable machine-readable id, matching the snag codes in the run's summary.md. */
  rule: string;
  severity: Severity;
  /** Which file the finding is in, as the operator names it (e.g. "config.env"). */
  file: string;
  /** 1-indexed line, when the finding belongs to a specific line. */
  line?: number;
  message: string;
  /**
   * One-line headline for the summary block at the top of the report. Defaults to the
   * message's first sentence, which is written to stand alone for exactly this reason.
   * Set it explicitly when the useful headline is the FIX rather than the diagnosis.
   */
  summary?: string;
  /**
   * The command that resolves this finding, when one command does.
   *
   * A finding with a `fix` is printed LAST — after the counts — because that is where the
   * eye lands when the report ends, and because it is the line the operator is about to
   * act on. Everything above it is diagnosis; this is the instruction.
   */
  fix?: string;
}

/**
 * Line-aware env parser.
 *
 * ⚠️ Deliberately a SEPARATE function from `parseConfigEnv` in `manifest-config.ts`,
 * not a replacement for it. `sign`/`env` depend on that parser's exact behaviour and
 * CI asserts it; this one only adds line numbers for diagnostics. The two must agree
 * on what a value IS — in particular that **everything after the first `=` is the
 * value**, which is the whole reason rule CFG_INLINE_COMMENT exists.
 */
export function parseEnvLines(text: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const s = (lines[i] ?? "").trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 1) continue;
    out.push({ key: s.slice(0, eq).trim(), value: s.slice(eq + 1).trim(), line: i + 1 });
  }
  return out;
}

export function entriesToRecord(entries: EnvEntry[]): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const e of entries) rec[e.key] = e.value;
  return rec;
}

/** Secrets that must never appear in `config.env` — it is the file the runbook calls
 * non-secret, and the run proved that a live Proxmox token pasted there works
 * perfectly and leaks. "It worked" is exactly why this needs a checker. */
const SECRET_KEYS_BANNED_IN_CONFIG = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SESSION_SECRET",
  "AGENT_KEY",
  "COALITION_KEY",
  "COALITION_SIGNING_KEY",
  "MANIFEST_KEY",
  "PROXMOX_TOKEN_SECRET",
  "PROXMOX_PASSWORD",
];

/** `.env.operator` legitimately holds Proxmox creds and MANIFEST_KEY — that is its job.
 * What does NOT belong there is Stripe: those are the Coalition's, and a copy here is
 * either a stray paste or a live key in a file nobody treats as sensitive. */
const SECRET_KEYS_BANNED_IN_OPERATOR = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];

/** Value-shape detectors for secrets that landed under an innocent key name. */
const SECRET_VALUE_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\bsk_(live|test)_[A-Za-z0-9]/, what: "a Stripe secret key" },
  { re: /\brk_(live|test)_[A-Za-z0-9]/, what: "a Stripe restricted key" },
  { re: /\bwhsec_[A-Za-z0-9]/, what: "a Stripe webhook secret" },
  { re: /PVEAPIToken=/, what: "a Proxmox API token" },
];

/** Rules 4 + 5: an env file is read VERBATIM — no shell, no expansion, no dequoting. */
function lintValueShape(entries: EnvEntry[], file: string): Finding[] {
  const found: Finding[] = [];
  for (const e of entries) {
    // ENVFILE_NO_EXPANSION — `MANIFEST_KEY=$(base64 -w0 key.pem)` ships the literal
    // text. Docker's --env-file does not run a shell, so the app receives "$(base64
    // …)" and fails far away as a bare 401 with nothing pointing back here.
    if (e.value.includes("$(") || e.value.includes("${")) {
      found.push({
        rule: "ENVFILE_NO_EXPANSION",
        severity: "error",
        file,
        line: e.line,
        message:
          `${e.key} contains a shell expansion — env files are read verbatim, so this ships ` +
          `literally. Run the command yourself and paste the RESULT.`,
      });
    }
    // Wrapping quotes survive into the value; "abc" is four characters, not three.
    if (e.value.length >= 2 && /^(".*"|'.*')$/.test(e.value)) {
      found.push({
        rule: "ENVFILE_QUOTED_VALUE",
        severity: "error",
        file,
        line: e.line,
        message: `${e.key} is wrapped in quotes — they become part of the value. Remove them.`,
      });
    }
    // CFG_INLINE_COMMENT — the parser takes EVERYTHING after `=`, so a trailing
    // comment is silently appended to the secret. Full-line `#` is fine.
    if (/\s#/.test(e.value)) {
      found.push({
        rule: "CFG_INLINE_COMMENT",
        severity: "error",
        file,
        line: e.line,
        message:
          `${e.key} has a trailing '#' comment — everything after '=' is the value, so the ` +
          `comment becomes part of it. Put comments on their own line.`,
      });
    }
  }
  return found;
}

/** Rule 6, split by which file may legitimately hold which secret. */
function lintSecretPlacement(entries: EnvEntry[], file: string, bannedKeys: string[]): Finding[] {
  const found: Finding[] = [];
  for (const e of entries) {
    if (!e.value) continue; // an empty skeleton slot is "not yet filled", not a leak
    if (bannedKeys.includes(e.key)) {
      found.push({
        rule: "SECRET_IN_NONSECRET_CONFIG",
        severity: "error",
        file,
        line: e.line,
        message: `${e.key} is a secret and does not belong in ${file} — move it to secrets.env.`,
      });
      continue;
    }
    for (const { re, what } of SECRET_VALUE_PATTERNS) {
      if (re.test(e.value)) {
        found.push({
          rule: "SECRET_IN_NONSECRET_CONFIG",
          severity: "error",
          file,
          line: e.line,
          message: `${e.key} looks like ${what}. It does not belong in ${file}.`,
        });
        break;
      }
    }
  }
  return found;
}

/** Rule 7: price floors, and the misplaced-zero check that caught a real $200 nimbus. */
export function lintTierPrices(
  entries: EnvEntry[],
  file: string,
  minimums: Record<string, number> = TIER_FLOORS_CENTS
): Finding[] {
  const entry = entries.find((e) => e.key === "TIER_PRICES_JSON");
  if (!entry) return [];
  let prices: unknown;
  try {
    prices = JSON.parse(entry.value);
  } catch {
    return [
      {
        rule: "PRICE_MALFORMED",
        severity: "error",
        file,
        line: entry.line,
        message: "TIER_PRICES_JSON is not valid JSON.",
      },
    ];
  }
  if (!prices || typeof prices !== "object" || Array.isArray(prices)) {
    return [
      {
        rule: "PRICE_MALFORMED",
        severity: "error",
        file,
        line: entry.line,
        message: 'TIER_PRICES_JSON must be an object like {"cumulus":700}.',
      },
    ];
  }
  const found: Finding[] = [];
  for (const [tier, cents] of Object.entries(prices as Record<string, unknown>)) {
    const floor = minimums[tier];
    if (floor == null) {
      found.push({
        rule: "PRICE_UNKNOWN_TIER",
        severity: "error",
        file,
        line: entry.line,
        message: `TIER_PRICES_JSON: unknown tier "${tier}".`,
      });
      continue;
    }
    if (!Number.isInteger(cents)) {
      found.push({
        rule: "PRICE_NOT_INTEGER_CENTS",
        severity: "error",
        file,
        line: entry.line,
        message: `TIER_PRICES_JSON (${tier}): integer CENTS required, got ${JSON.stringify(cents)}.`,
      });
      continue;
    }
    const n = cents as number;
    if (n < floor) {
      found.push({
        rule: "PRICE_BELOW_FLOOR",
        severity: "error",
        file,
        line: entry.line,
        message: `TIER_PRICES_JSON (${tier}): ${n} cents is below the platform floor ${floor}; MT rejects it with a 422.`,
      });
    } else if (n > floor * PRICE_SANITY_MULTIPLE) {
      // PRICE_ZEROS: $200 for a $20 tier nearly reached a customer once.
      found.push({
        rule: "PRICE_ZEROS",
        severity: "warning",
        file,
        line: entry.line,
        message:
          `TIER_PRICES_JSON (${tier}): ${n} cents is more than ${PRICE_SANITY_MULTIPLE}× the floor ` +
          `${floor}. If that is deliberate, ignore this — otherwise it is an extra zero.`,
      });
    }
  }
  return found;
}

/** Rule 1: the four values duplicated by hand between config.env and .env.operator. */
const CROSS_FILE_KEYS = ["PROVIDER_SLUG", "MT_BASE_URL", "OWNER_ADDRESS", "COALITION_URL"];

export function lintCrossFile(
  config: Record<string, string>,
  operator: Record<string, string>
): Finding[] {
  const found: Finding[] = [];
  for (const key of CROSS_FILE_KEYS) {
    const a = config[key];
    const b = operator[key];
    if (!a || !b) continue; // absence is covered by the courier rule below
    if (a !== b) {
      found.push({
        rule: "ENV_DUPLICATED_ACROSS_FILES",
        severity: "error",
        file: ".env.operator",
        message:
          `${key} differs between config.env (${a}) and .env.operator (${b}). ` +
          `This is how half a deployment ends up pointed at staging.`,
      });
    }
  }
  return found;
}

/**
 * `AGENT_LISTING_JSON` must be an ARRAY of `{tier, priceCents, availableSlots}` — the
 * shape `agent/src/config.ts` parses. `init` used to write the TIER_PRICES_JSON map
 * here, and the only symptom was the agent exiting at startup on a ZodError, before
 * it had asserted anything: nothing that came later could point back at the cause.
 *
 * Also checks the price against `TIER_PRICES_JSON`, because the two files are the two
 * halves of one answer — disagree, and MT and the Coalition quote different numbers
 * for the same tier.
 */
export function lintListing(
  operator: Record<string, string>,
  config: Record<string, string>,
  minimums: Record<string, number>
): Finding[] {
  const raw = operator.AGENT_LISTING_JSON;
  if (!raw) return []; // absent = nothing offered for sale; a valid self-hoster state
  const file = ".env.operator";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return [
      {
        rule: "LISTING_MALFORMED",
        severity: "error",
        file,
        message: `AGENT_LISTING_JSON is not valid JSON: ${(e as Error).message}`,
      },
    ];
  }
  if (!Array.isArray(parsed)) {
    return [
      {
        rule: "LISTING_NOT_AN_ARRAY",
        severity: "error",
        file,
        message:
          "AGENT_LISTING_JSON must be an ARRAY of {tier, priceCents, availableSlots}, not " +
          "the TIER_PRICES_JSON map. The agent exits at startup with `ZodError: Expected " +
          "array, received object` and asserts nothing, so no later symptom names this.",
      },
    ];
  }

  const found: Finding[] = [];
  let prices: Record<string, unknown> = {};
  try {
    prices = config.TIER_PRICES_JSON ? JSON.parse(config.TIER_PRICES_JSON) : {};
  } catch {
    // config.env's own price rules already report this; don't double-report here.
  }
  for (const entry of parsed as Array<Record<string, unknown>>) {
    const tier = typeof entry?.tier === "string" ? entry.tier : undefined;
    if (!tier) {
      found.push({
        rule: "LISTING_MALFORMED",
        severity: "error",
        file,
        message: `AGENT_LISTING_JSON has an entry with no tier: ${JSON.stringify(entry)}`,
      });
      continue;
    }
    if (!Number.isInteger(entry.priceCents) || (entry.priceCents as number) <= 0) {
      found.push({
        rule: "LISTING_MALFORMED",
        severity: "error",
        file,
        message: `AGENT_LISTING_JSON: ${tier} needs an integer priceCents in CENTS.`,
      });
    } else if (minimums[tier] != null && (entry.priceCents as number) < minimums[tier]!) {
      found.push({
        rule: "PRICE_BELOW_FLOOR",
        severity: "error",
        file,
        message: `AGENT_LISTING_JSON: ${tier} at ${entry.priceCents} is below the platform minimum ${minimums[tier]}.`,
      });
    }
    if (!Number.isInteger(entry.availableSlots) || (entry.availableSlots as number) < 0) {
      found.push({
        rule: "LISTING_MALFORMED",
        severity: "error",
        file,
        message:
          `AGENT_LISTING_JSON: ${tier} needs availableSlots — how many to OFFER. ` +
          "Flux Hub clamps it to your live available slots, so it cannot oversell.",
      });
    }
    const configured = prices[tier];
    if (typeof configured === "number" && configured !== entry.priceCents) {
      found.push({
        rule: "PRICE_DISAGREES_ACROSS_FILES",
        severity: "error",
        file,
        message:
          `${tier} is ${entry.priceCents} in AGENT_LISTING_JSON but ${configured} in ` +
          "config.env's TIER_PRICES_JSON — Flux Hub and your Coalition would quote different prices.",
      });
    }
  }
  return found;
}

/** Rule 8: the courier fails OPEN and SILENT — `courier=off` in one startup line and
 * nothing else, ever. No authorization request will reach the operator. */
/** Which onboarding step issues each value, so "not yet filled" can say what to do. */
/**
 * Where each empty value comes from.
 *
 * ⚠️ `init` now FILLS MANIFEST_KEY (from the key it requires) and GENERATES
 * SESSION_SECRET, and asks for the Proxmox pair. Seeing any of those four empty no
 * longer means "a later step issues it" — it means the file predates that change or
 * was hand-edited, so each says how to get it back rather than describing a step that
 * no longer exists.
 */
const SUPPLIED_BY: Record<string, string> = {
  MANIFEST_KEY: "`mt-manifest init`, from manifest-key.pem — re-run it, or paste `base64 -w0 manifest-key.pem`",
  OWNER_ADDRESS: "your wallet address — the one you sign with at /onboard",
  AGENT_KEY: "the /onboard web flow, after you sign",
  COALITION_KEY: "the /onboard web flow, after you sign",
  SESSION_SECRET: "`mt-manifest init` — any long random string, e.g. `openssl rand -hex 32`",
  STRIPE_SECRET_KEY: "the Stripe dashboard (Developers → API keys)",
  STRIPE_WEBHOOK_SECRET: "the Stripe dashboard, shown once when you create the endpoint",
  PROXMOX_TOKEN_ID: "`pveum user token add` — the id, e.g. `fluxhub@pve!agent`",
  PROXMOX_TOKEN_SECRET: "`pveum user token add`, printed ONCE when the token is created",
};

/**
 * The Proxmox token pair is the agent's only way to authenticate — there is no
 * password path in the agent at all. Both were EMPTY on the pve50 cold run while
 * `doctor` reported 0 errors and 0 warnings, because `.env.operator` had no
 * required-field check beyond the courier keys: the same skeleton state that
 * `secrets.env` reports faithfully was silent one file over.
 */
export function lintProxmoxCreds(
  operator: Record<string, string>,
  operatorFile: string
): Finding[] {
  const found: Finding[] = [];
  for (const key of ["PROXMOX_TOKEN_ID", "PROXMOX_TOKEN_SECRET"]) {
    if (operator[key]) continue;
    // Same three-state distinction as the courier keys: present-but-empty is the
    // scaffold waiting on a later step, absent is a real misconfiguration.
    const isSkeletonSlot = key in operator;
    found.push({
      rule: isSkeletonSlot ? "NOT_YET_FILLED" : "PROXMOX_CREDS_MISSING",
      severity: isSkeletonSlot ? "warning" : "error",
      file: operatorFile,
      message: isSkeletonSlot
        ? `${key} is empty — supplied by ${SUPPLIED_BY[key]}. The agent cannot make a ` +
          `single Proxmox call until it is filled.`
        : `${key} is missing — the agent authenticates to Proxmox by API token only, ` +
          `so it cannot reach ${operator.PROXMOX_URL ?? "Proxmox"} at all.`,
    });
  }
  return found;
}

export function lintCourier(operator: Record<string, string>, operatorFile: string): Finding[] {
  const found: Finding[] = [];
  if (operator.COALITION_URL == null) {
    found.push({
      rule: "COURIER_SILENT_OFF",
      severity: "error",
      file: operatorFile,
      message:
        "COALITION_URL is not set — the agent starts with courier=off and never delivers " +
        "authorization requests. The only symptom is that word in the startup log.",
    });
    return found;
  }
  for (const key of ["MANIFEST_KEY", "OWNER_ADDRESS"]) {
    if (operator[key]) continue;
    // Present-but-empty is the SKELETON state: `init` wrote the slot and the operator
    // has not reached the step that issues the value yet. That is a third state — not
    // configured, not broken — and reporting it as an error would make the wizard's
    // own first-run output look like a fault. Absent entirely is a real misconfig.
    const isSkeletonSlot = key in operator;
    found.push({
      rule: isSkeletonSlot ? "NOT_YET_FILLED" : "COURIER_SILENT_OFF",
      severity: isSkeletonSlot ? "warning" : "error",
      file: operatorFile,
      message: isSkeletonSlot
        ? `${key} is empty — supplied by ${SUPPLIED_BY[key] ?? "a later onboarding step"}. ` +
          `Until it is filled the agent runs with courier=off.`
        : `COALITION_URL is set but ${key} is missing — the courier cannot authenticate.`,
    });
  }
  return found;
}

/**
 * Report every empty slot in secrets.env as "not yet filled", naming its source.
 *
 * ⚠️ A Flux Hub SUPPORTER sells nothing and has no Stripe account, so an empty Stripe
 * pair is not a pending step for them — it is the correct final state. `init` does not
 * even write those lines for a supporter; this covers the hand-written file. Warning
 * about something that will never be filled teaches the operator to skim the list, and
 * the three warnings that DO matter are in that same list.
 */
function lintSkeletonSlots(entries: EnvEntry[], file: string, opts: { supporter?: boolean } = {}): Finding[] {
  return entries
    .filter((e) => e.value === "")
    .filter((e) => !(opts.supporter && e.key.startsWith("STRIPE_")))
    .map((e) => ({
      rule: "NOT_YET_FILLED",
      severity: "warning" as const,
      file,
      line: e.line,
      message: `${e.key} is empty — supplied by ${SUPPLIED_BY[e.key] ?? "a later onboarding step"}.`,
    }));
}

export interface InventoryHost {
  name?: string;
  slots?: Array<{ vmName?: string; lanIp?: string }>;
}

/**
 * `inventory.json` is a top-level ARRAY of hosts — verified against the live
 * `~/mt-agents/test1/data/inventory.json`, which is the known-good output of a real
 * onboarding. An earlier draft of this linter assumed `{ "hosts": [...] }` and so
 * silently checked nothing at all, which is the same failure mode it exists to catch.
 * The object form is still accepted defensively, because a checker that quietly
 * examines zero hosts is worse than one that errors.
 */
export function normalizeInventory(parsed: unknown): InventoryHost[] | null {
  if (Array.isArray(parsed)) return parsed as InventoryHost[];
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { hosts?: unknown }).hosts)) {
    return (parsed as { hosts: InventoryHost[] }).hosts;
  }
  return null;
}

/** Rules 2 + 3, over inventory.json. */
export function lintInventory(
  inventoryText: string,
  hostsFromConfig: string[],
  file = "inventory.json"
): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inventoryText);
  } catch (e) {
    return [
      { rule: "INVENTORY_MALFORMED", severity: "error", file, message: `not valid JSON: ${(e as Error).message}` },
    ];
  }
  const hosts = normalizeInventory(parsed);
  if (hosts == null) {
    return [
      {
        rule: "INVENTORY_MALFORMED",
        severity: "error",
        file,
        message: "expected a top-level array of hosts (or an object with a `hosts` array).",
      },
    ];
  }
  const found: Finding[] = [];
  for (const host of hosts) {
    // HOSTS_UNATTESTED — MT pins the manifest's hardware[] at ingest and 409s any
    // inventory host that is not on it. Loud, but trivially preventable here.
    if (host.name && hostsFromConfig.length > 0 && !hostsFromConfig.includes(host.name)) {
      found.push({
        rule: "HOSTS_UNATTESTED",
        severity: "error",
        file,
        message:
          `host "${host.name}" is not in config.env HOSTS (${hostsFromConfig.join(", ")}). ` +
          `MT rejects an unattested host with a 409.`,
      });
    }
    for (const slot of host.slots ?? []) {
      // A bare lanIp becomes /32 — no gateway, node boots with no route out, and
      // nothing anywhere says why.
      if (slot.lanIp && !/\/\d{1,2}$/.test(slot.lanIp)) {
        found.push({
          rule: "LANIP_NO_CIDR",
          severity: "error",
          file,
          message:
            `slot ${slot.vmName ?? "(unnamed)"}: lanIp "${slot.lanIp}" has no /NN suffix — it ` +
            `becomes /32, the node gets no gateway and boots unreachable.`,
        });
      }
    }
  }
  return found;
}

export interface DoctorInput {
  /** Raw text of each file, when present in the working directory. */
  configEnv?: string;
  secretsEnv?: string;
  envOperator?: string;
  inventoryJson?: string;
  /** The signed manifest, when one has been produced. */
  manifestJson?: string;
  /** Live minimums from `GET /api/tiers`; omitted = use the bundled fallback. */
  tierMinimums?: Record<string, number>;
}

export interface DoctorReport {
  findings: Finding[];
  /** Files that were actually examined, for an honest summary line. */
  filesChecked: string[];
  /** Whether price rules came from the live API or the bundled fallback. Reported,
   * because "your price is fine" means less if it was checked against stale numbers. */
  minimumsSource: "api" | "bundled";
}

/**
 * Run every file-level rule over whatever exists.
 *
 * Missing files are skipped rather than failed: `doctor` is meant to be useful
 * halfway through onboarding, when only some of the five exist yet.
 */

/**
 * Is the signed manifest still the config.env beside it?
 *
 * `init` now signs manifest.json for the operator, which means the file can go stale in a
 * way it never could when signing was a command you ran deliberately: edit config.env —
 * change a price, add a host — and the manifest on disk still carries the OLD values,
 * correctly signed. Pasting it at /onboard then ingests the old provider, silently and
 * with every signature valid. Nothing downstream can catch that; only this comparison can.
 *
 * Compares the manifest BODY against what config.env renders right now, ignoring the three
 * fields signing itself stamps (pubkey, publishedAt, signature). Same canonicalization the
 * signature uses, so "differs" here means the signed bytes really would differ.
 */
export function lintManifestFreshness(manifestJson: string, configEnv: string): Finding[] {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestJson) as Record<string, unknown>;
  } catch (e) {
    return [
      {
        rule: "MANIFEST_UNPARSEABLE",
        severity: "error",
        file: "manifest.json",
        message: `manifest.json is not valid JSON (${(e as Error).message}) — re-run \`mt-manifest sign\`.`,
        summary: "not valid JSON — re-run `mt-manifest sign`",
        fix: "mt-manifest sign",
      },
    ];
  }
  // An 'authorize' wrapper is the same manifest with an owner signature around it.
  const inner = (manifest.manifest as Record<string, unknown> | undefined) ?? manifest;

  if (!verifyManifestObject(inner)) {
    return [
      {
        rule: "MANIFEST_SIG_INVALID",
        severity: "error",
        file: "manifest.json",
        message:
          "manifest.json does not verify against its own pubkey — it was edited by hand after " +
          "signing. Change config.env instead and re-run `mt-manifest sign`.",
        summary: "edited by hand after signing — re-run `mt-manifest sign`",
        fix: "mt-manifest sign",
      },
    ];
  }

  let fresh: Record<string, unknown>;
  try {
    fresh = renderManifestBodyFromConfig(configEnv);
  } catch {
    return []; // config.env itself is broken; other rules report that, and better.
  }
  const { pubkey: _p, publishedAt: _t, signature: _s, ...signedBody } = inner;
  if (canonicalize(signedBody) === canonicalize(fresh)) return [];

  const changed = [...new Set([...Object.keys(fresh), ...Object.keys(signedBody)])]
    .filter((k) => canonicalize(fresh[k] ?? null) !== canonicalize(signedBody[k] ?? null))
    .sort();
  return [
    {
      rule: "MANIFEST_STALE",
      severity: "error",
      file: "manifest.json",
      message:
        `manifest.json was signed from an older config.env (differs at: ${changed.join(", ")}). ` +
        "Pasting it at /onboard would ingest the OLD values, correctly signed.",
      summary: `signed from an older config.env (${changed.join(", ")}) — re-run \`mt-manifest sign\``,
      fix: "mt-manifest sign",
    },
  ];
}

export function runDoctor(input: DoctorInput): DoctorReport {
  const findings: Finding[] = [];
  const filesChecked: string[] = [];
  const minimums = input.tierMinimums ?? TIER_FLOORS_CENTS;
  const minimumsSource: "api" | "bundled" = input.tierMinimums ? "api" : "bundled";

  let configRec: Record<string, string> = {};
  let hostsFromConfig: string[] = [];

  if (input.configEnv != null) {
    filesChecked.push("config.env");
    const entries = parseEnvLines(input.configEnv);
    configRec = entriesToRecord(entries);
    hostsFromConfig = (configRec.HOSTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    findings.push(...lintValueShape(entries, "config.env"));
    findings.push(...lintSecretPlacement(entries, "config.env", SECRET_KEYS_BANNED_IN_CONFIG));
    findings.push(...lintTierPrices(entries, "config.env", minimums));
  }

  if (input.secretsEnv != null) {
    filesChecked.push("secrets.env");
    // Only shape rules apply — secrets.env is SUPPOSED to hold secrets. An empty
    // value here is the skeleton state ("not yet filled"), reported as a warning
    // naming the step that issues it: a fresh scaffold must not look broken.
    const secretEntries = parseEnvLines(input.secretsEnv);
    findings.push(...lintValueShape(secretEntries, "secrets.env"));
    findings.push(
      ...lintSkeletonSlots(secretEntries, "secrets.env", {
        supporter: configRec.PROVIDER_LEVEL === "supporter",
      })
    );
  }

  let operatorRec: Record<string, string> = {};
  if (input.envOperator != null) {
    filesChecked.push(".env.operator");
    const entries = parseEnvLines(input.envOperator);
    operatorRec = entriesToRecord(entries);
    findings.push(...lintValueShape(entries, ".env.operator"));
    findings.push(...lintSecretPlacement(entries, ".env.operator", SECRET_KEYS_BANNED_IN_OPERATOR));
    findings.push(...lintCourier(operatorRec, ".env.operator"));
    findings.push(...lintProxmoxCreds(operatorRec, ".env.operator"));
  }

  if (input.configEnv != null && input.envOperator != null) {
    findings.push(...lintCrossFile(configRec, operatorRec));
    findings.push(...lintListing(operatorRec, configRec, minimums));
  }

  if (input.inventoryJson != null) {
    filesChecked.push("inventory.json");
    findings.push(...lintInventory(input.inventoryJson, hostsFromConfig));
  }

  if (input.manifestJson != null && input.configEnv != null) {
    filesChecked.push("manifest.json");
    findings.push(...lintManifestFreshness(input.manifestJson, input.configEnv));
  }

  return { findings, filesChecked, minimumsSource };
}

/** Human-readable report. Returns the text and whether anything is fatal. */

/**
 * The first sentence of a finding's message, used as its headline when it has no explicit
 * `summary`. Every rule's message is written to open with a standalone statement of what
 * is wrong, so this is a real headline rather than a truncation — and a message that is
 * already one sentence is simply itself, which is why such findings are not printed twice.
 */
/** Is a bracket still open at the end of this slice? Cheap, and enough: report messages
 * quote third-party errors inside parentheses and never nest exotically. */
function unclosed(head: string): boolean {
  let depth = 0;
  for (const ch of head) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

function firstSentence(message: string): string {
  // "e.g." and friends end in a period followed by a space and are not sentence ends.
  // Getting this wrong truncates a headline mid-clause ("supplied by `pveum user token
  // add` — the id, e.g."), which reads as a bug in the tool rather than a short summary.
  const ABBREV = /(?:^|\s)(?:e\.g|i\.e|etc|vs|approx|Dr|Mr|Ms)\.$/;
  for (const m of message.matchAll(/[.!?](?=\s|$)/g)) {
    const end = m.index! + 1;
    const head = message.slice(0, end);
    if (ABBREV.test(head)) continue;
    // A period INSIDE brackets does not end the sentence. Stripe quotes its own error
    // verbatim inside our parenthetical — "(403: Permission denied. The provided key …" —
    // so the first period landed mid-quote and produced a headline with an unbalanced "("
    // that also cut off the half naming the permission to grant. Any headline that reads
    // as a truncation bug costs more than the length it saved.
    if (unclosed(head)) continue;
    return head.trim();
  }
  return message;
}

export function formatReport(report: DoctorReport): { text: string; ok: boolean } {
  const errors = report.findings.filter((f) => f.severity === "error");
  const warnings = report.findings.filter((f) => f.severity === "warning");
  const lines: string[] = [];

  if (report.filesChecked.length === 0) {
    return {
      text: "doctor: no onboarding files found here (looked for config.env, secrets.env, .env.operator, inventory.json).",
      ok: false,
    };
  }

  // TWO BLOCKS: headlines, then the detail behind each.
  //
  // A single block of full-sentence findings is unreadable at the size this report reaches
  // — the run that prompted this had two errors whose messages wrapped over four lines
  // each, and the one that mattered could not be picked out at a glance. The headline
  // block is what you scan; the detail block is what you read once you know which one you
  // care about. Same findings, same order, twice.
  const headline = (f: Finding): string => f.summary ?? firstSentence(f.message);
  const label = (f: Finding): string => (f.severity === "error" ? "ERROR" : "warn ");
  const where = (f: Finding): string => (f.line != null ? `${f.file}:${f.line}` : f.file);

  // Errors first in BOTH blocks. Findings are generated in file order, which on a fresh
  // scaffold puts five routine "not yet filled" warnings above the one error that stops
  // the deployment — exactly the report that sent tom looking for a message he could not
  // see. Severity is the only ordering the reader cares about.
  const ranked = [...errors, ...warnings];
  // A finding with a one-command fix is held back for the END of the report — after the
  // counts, where the eye lands and where nothing scrolls past it. In the middle of a
  // headline list it is one line among nine; last, it is the next thing you type.
  const actionable = ranked.filter((f) => f.fix);
  for (const f of ranked.filter((f) => !f.fix)) {
    lines.push(`${label(f)}  ${where(f)}  [${f.rule}] ${headline(f)}`);
  }
  // Only worth printing twice when the detail actually says more than the headline did.
  const expanded = ranked.filter((f) => headline(f) !== f.message);
  if (expanded.length > 0) {
    lines.push("");
    for (const f of expanded) {
      lines.push(`${label(f)}  ${where(f)}  [${f.rule}]  ${f.message}`);
    }
  }
  if (lines.length > 0) lines.push("");
  lines.push(
    `checked ${report.filesChecked.join(", ")} — ${errors.length} error(s), ${warnings.length} warning(s)`
  );
  if (report.minimumsSource === "bundled") {
    lines.push(
      "note: could not reach Flux Hub for live tier minimums; price rules used this tool's " +
        "bundled copy, which may be out of date."
    );
  }
  if (errors.length === 0 && warnings.length === 0) lines.push("everything agrees.");
  if (actionable.length > 0) {
    lines.push("");
    for (const f of actionable) {
      lines.push(`${label(f)}  ${where(f)}  [${f.rule}] ${headline(f)}`);
    }
  }
  return { text: lines.join("\n"), ok: errors.length === 0 };
}
