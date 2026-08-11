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

/** Rule 8: the courier fails OPEN and SILENT — `courier=off` in one startup line and
 * nothing else, ever. No authorization request will reach the operator. */
/** Which onboarding step issues each value, so "not yet filled" can say what to do. */
const SUPPLIED_BY: Record<string, string> = {
  MANIFEST_KEY: "`mt-manifest keygen`, then paste the base64 of manifest-key.pem",
  OWNER_ADDRESS: "your wallet address — the one you sign with at /onboard",
  AGENT_KEY: "the /onboard web flow, after you sign",
  COALITION_KEY: "the /onboard web flow, after you sign",
  SESSION_SECRET: "`openssl rand -hex 32`",
  STRIPE_SECRET_KEY: "the Stripe dashboard (Developers → API keys)",
  STRIPE_WEBHOOK_SECRET: "the Stripe dashboard, shown once when you create the endpoint",
};

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

/** Report every empty slot in secrets.env as "not yet filled", naming its source. */
function lintSkeletonSlots(entries: EnvEntry[], file: string): Finding[] {
  return entries
    .filter((e) => e.value === "")
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
    findings.push(...lintSkeletonSlots(secretEntries, "secrets.env"));
  }

  let operatorRec: Record<string, string> = {};
  if (input.envOperator != null) {
    filesChecked.push(".env.operator");
    const entries = parseEnvLines(input.envOperator);
    operatorRec = entriesToRecord(entries);
    findings.push(...lintValueShape(entries, ".env.operator"));
    findings.push(...lintSecretPlacement(entries, ".env.operator", SECRET_KEYS_BANNED_IN_OPERATOR));
    findings.push(...lintCourier(operatorRec, ".env.operator"));
  }

  if (input.configEnv != null && input.envOperator != null) {
    findings.push(...lintCrossFile(configRec, operatorRec));
  }

  if (input.inventoryJson != null) {
    filesChecked.push("inventory.json");
    findings.push(...lintInventory(input.inventoryJson, hostsFromConfig));
  }

  return { findings, filesChecked, minimumsSource };
}

/** Human-readable report. Returns the text and whether anything is fatal. */
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

  for (const f of report.findings) {
    const where = f.line != null ? `${f.file}:${f.line}` : f.file;
    lines.push(`${f.severity === "error" ? "ERROR" : "warn "}  ${where}  [${f.rule}]  ${f.message}`);
  }
  if (lines.length > 0) lines.push("");
  lines.push(
    `checked ${report.filesChecked.join(", ")} — ${errors.length} error(s), ${warnings.length} warning(s)`
  );
  if (report.minimumsSource === "bundled") {
    lines.push(
      "note: could not reach MT for live tier minimums; price rules used this tool's " +
        "bundled copy, which may be out of date."
    );
  }
  if (errors.length === 0 && warnings.length === 0) lines.push("everything agrees.");
  return { text: lines.join("\n"), ok: errors.length === 0 };
}
