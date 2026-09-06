/**
 * `level` — change PROVIDER_LEVEL and the Stripe pair, surgically.
 *
 * Flux Hub tells people to start as a Supporter and promises that upgrading later is
 * simple. Until this existed, the promise was unbacked: the only two ways to change your
 * level were
 *
 *   - `init --force`, a full destructive re-scaffold. It mints a new SESSION_SECRET
 *     (logging out open Coalition sessions), blanks the three /onboard-issued keys, and
 *     rewrites data/inventory.json over any agent or hand edits. A two-field change
 *     should not cost all of that.
 *   - hand-editing config.env and secrets.env, which means inventing the STRIPE_* block
 *     from scratch in a file where a trailing `# note` silently becomes part of the
 *     secret.
 *
 * So: line-preserving editors, and a plan object the CLI both PRINTS and APPLIES, so the
 * preview and the effect cannot drift apart.
 *
 * Everything here is pure — no I/O — because the interesting cases are all about which
 * bytes survive, and those are worth asserting without a tmpdir and a subprocess.
 */

export type Level = "supporter" | "operator";

/** What a `level` run would do, or did. The CLI prints this and then applies it. */
export interface LevelChange {
  /** `undefined` = the file declares no level at all. Legacy manifests omit it. */
  from: Level | undefined;
  to: Level;
  /** True when nothing would change: already there, priced, and Stripe filled. */
  noop: boolean;
  configEdits: string[];
  secretsEdits: string[];
  warnings: string[];
  nextSteps: string[];
  configText: string;
  secretsText: string;
}

/**
 * The value of a `KEY=` line, or undefined.
 *
 * ⚠️ Matches `parseConfigEnv`'s rule exactly: everything after the first `=` is the
 * value, trailing comment included. A `PROVIDER_LEVEL=operator # for now` line therefore
 * reads as `"operator # for now"` and is NOT a level — which is correct, because that is
 * precisely what the signing path will do with it. Silently trimming the comment here
 * would make `level` disagree with `sign` about what the file says, and `doctor`'s
 * CFG_INLINE_COMMENT is what tells the operator to fix it.
 */
export function readEnvValue(text: string, key: string): string | undefined {
  for (const raw of text.split("\n")) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 1) continue;
    if (s.slice(0, i).trim() === key) return s.slice(i + 1).trim();
  }
  return undefined;
}

/** The declared level, or undefined for a file that does not declare one. */
export function readLevel(configText: string): Level | undefined {
  const v = readEnvValue(configText, "PROVIDER_LEVEL");
  return v === "supporter" || v === "operator" ? v : undefined;
}

/**
 * Replace a `KEY=` line's value in place, or append the key if it is absent.
 *
 * In place means IN PLACE: same position, same surrounding lines, same comments. The
 * whole point of this command is that an operator can diff their config afterwards and
 * see two changed lines, not a regenerated file.
 *
 * Appended comments each go on their OWN line. That is correctness, not style — a
 * trailing `# note` becomes part of the value.
 */
export function upsertEnvLine(
  text: string,
  key: string,
  value: string,
  comments: string[] = []
): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 1 || s.slice(0, eq).trim() !== key) continue;
    // Preserve the original indentation, on the off chance the file has any.
    const indent = line.slice(0, line.length - line.trimStart().length);
    lines[i] = `${indent}${key}=${value}`;
    return lines.join("\n");
  }
  // Absent: append, keeping exactly one trailing newline whatever the file had.
  const body = text.replace(/\n+$/, "");
  const added = [...comments.map((c) => (c.startsWith("#") ? c : `# ${c}`)), `${key}=${value}`];
  return `${body}\n${added.join("\n")}\n`;
}

/** `TIER_PRICES_JSON`, rendered the way `renderConfigEnv` renders it. */
export function setTierPrices(configText: string, prices: Record<string, number>): string {
  return upsertEnvLine(configText, "TIER_PRICES_JSON", JSON.stringify(prices));
}

/**
 * The Stripe pair, with the same comment text `renderSecretsEnv` writes for a selling
 * scaffold — so an upgraded secrets.env is byte-comparable with a natively generated
 * Operator one, and a later diff of the two shows nothing.
 */
export const STRIPE_COMMENTS = {
  header: "# Stripe — required because you listed at least one PAID tier.",
  secretKey: "# STRIPE_SECRET_KEY: Stripe dashboard > Developers > API keys (use a restricted key).",
  webhook: [
    "# STRIPE_WEBHOOK_SECRET: shown ONCE when you create the webhook endpoint.",
    "# It is bound to THAT endpoint — a secret from a different endpoint fails silently",
    "# and checkout simply never completes. Empty until you create the endpoint, which",
    "# needs the Coalition URL above — that is a real wait, not a missing question.",
  ],
} as const;

export function addStripeBlock(
  secretsText: string,
  opts: { secretKey?: string; webhookSecret?: string } = {}
): string {
  const hasKey = readEnvValue(secretsText, "STRIPE_SECRET_KEY") !== undefined;
  const hasHook = readEnvValue(secretsText, "STRIPE_WEBHOOK_SECRET") !== undefined;

  // Both present: this is an upgrade over an already-Stripe-shaped file (or a second
  // run). Only fill what was asked for; never blank a key that is already there.
  if (hasKey && hasHook) {
    let out = secretsText;
    if (opts.secretKey) out = upsertEnvLine(out, "STRIPE_SECRET_KEY", opts.secretKey);
    if (opts.webhookSecret) out = upsertEnvLine(out, "STRIPE_WEBHOOK_SECRET", opts.webhookSecret);
    return out;
  }

  // A Supporter scaffold ends with the "no Stripe keys needed" note, which is now wrong.
  // Drop exactly that block rather than leaving a paragraph contradicting the keys below.
  const body = secretsText
    .replace(
      /\n*# No Stripe keys needed:[\s\S]*?Stripe is what lets STRANGERS buy from you\.\n?/,
      "\n"
    )
    .replace(/\n+$/, "");

  const lines = [body, "", STRIPE_COMMENTS.header];
  if (!hasKey) {
    lines.push(STRIPE_COMMENTS.secretKey, `STRIPE_SECRET_KEY=${opts.secretKey ?? ""}`);
  }
  if (!hasHook) {
    lines.push(...STRIPE_COMMENTS.webhook, `STRIPE_WEBHOOK_SECRET=${opts.webhookSecret ?? ""}`);
  }
  return lines.join("\n") + "\n";
}

/** Parse `TIER_PRICES_JSON` into a map, treating anything unusable as empty. */
export function readTierPrices(configText: string): Record<string, number> {
  const raw = readEnvValue(configText, "TIER_PRICES_JSON");
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isInteger(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export interface LevelChangeInput {
  configText: string;
  secretsText: string;
  target: Level;
  /** Tier → price in CENTS. Only used going up. */
  prices?: Record<string, number>;
  stripe?: { secretKey?: string; webhookSecret?: string };
  /** Where the operator's own hub lives, for the next-steps text. */
  hubBaseUrl?: string;
}

/**
 * Decide the whole change, without performing any of it.
 *
 * The CLI prints this for `--dry-run` and for the confirmation, then writes
 * `configText`/`secretsText` verbatim. One object, one decision — a preview computed by
 * different code from the effect is a preview that will eventually lie.
 */
export function planLevelChange(input: LevelChangeInput): LevelChange {
  const from = readLevel(input.configText);
  const to = input.target;
  const configEdits: string[] = [];
  const secretsEdits: string[] = [];
  const warnings: string[] = [];
  const nextSteps: string[] = [];

  let configText = input.configText;
  let secretsText = input.secretsText;

  if (from === undefined) {
    warnings.push(
      "config.env declares no PROVIDER_LEVEL. An absent level is read as `operator` " +
        "everywhere downstream, so this writes the field for the first time."
    );
  }

  if (to === "operator") {
    const prices = { ...readTierPrices(configText), ...(input.prices ?? {}) };
    if (from !== "operator") {
      configText = upsertEnvLine(configText, "PROVIDER_LEVEL", "operator");
      configEdits.push(`PROVIDER_LEVEL: ${from ?? "(absent)"} → operator`);
    }
    if (Object.keys(prices).length > 0) {
      const before = readTierPrices(configText);
      if (JSON.stringify(before) !== JSON.stringify(prices)) {
        configText = setTierPrices(configText, prices);
        configEdits.push(
          `TIER_PRICES_JSON: ${JSON.stringify(before)} → ${JSON.stringify(prices)}`
        );
      }
    } else {
      warnings.push(
        "no tier prices — an operator with an empty TIER_PRICES_JSON has nothing for " +
          "sale, which is the half-finished state `doctor` reports as LEVEL_OPERATOR_NO_TIERS."
      );
    }

    const beforeSecrets = secretsText;
    secretsText = addStripeBlock(secretsText, input.stripe ?? {});
    if (beforeSecrets !== secretsText) {
      const key = readEnvValue(secretsText, "STRIPE_SECRET_KEY");
      const hook = readEnvValue(secretsText, "STRIPE_WEBHOOK_SECRET");
      secretsEdits.push(
        `STRIPE_SECRET_KEY: ${key ? "set" : "added, EMPTY — fill it in"}`,
        `STRIPE_WEBHOOK_SECRET: ${hook ? "set" : "added, EMPTY — minted when you create the endpoint"}`
      );
    }
  } else {
    if (from !== "supporter") {
      configText = upsertEnvLine(configText, "PROVIDER_LEVEL", "supporter");
      configEdits.push(`PROVIDER_LEVEL: ${from ?? "(absent)"} → supporter`);
    }
    const before = readTierPrices(configText);
    if (Object.keys(before).length > 0) {
      configText = setTierPrices(configText, {});
      configEdits.push(`TIER_PRICES_JSON: ${JSON.stringify(before)} → {} (nothing listed for sale)`);
    }
    // The Stripe keys stay. They are inert once nothing is for sale, and re-entering
    // them is the tedious half of coming back up. Blanking them would also destroy a
    // webhook secret that Stripe only ever showed once.
    if (readEnvValue(secretsText, "STRIPE_SECRET_KEY") !== undefined) {
      warnings.push(
        "your Stripe keys are left in place — inert while nothing is for sale, and the " +
          "webhook secret is one Stripe only shows once."
      );
    }
    warnings.push(
      "this tool cannot see your live rentals. A customer renting from you right now " +
        "is unaffected by this file, but you will not be able to sell anything new. " +
        "Check your fleet on Flux Hub before you rely on that."
    );
  }

  const noop = configEdits.length === 0 && secretsEdits.length === 0;
  if (!noop) {
    const hub = input.hubBaseUrl ?? "https://fluxhub.moltentech.us";
    nextSteps.push(
      "PROVIDER_LEVEL is in your SIGNED manifest, so Flux Hub needs a re-ingest:",
      "  1. fh-toolkit sign",
      `  2. paste manifest.json at ${hub}/onboard and sign with your owner wallet`,
      "     — the hub re-ingests there; nothing this command wrote reaches it until you do"
    );
    if (to === "operator") {
      nextSteps.push(
        "",
        "Stripe (you are merchant of record; Flux Hub never holds these):",
        "  3. register a webhook endpoint at <your coalition>/webhook, then:",
        "     fh-toolkit doctor --check-stripe    ← catches a key from the wrong account",
        "  4. fh-toolkit env, re-import env.json into the Flux app, redeploy"
      );
    }
    nextSteps.push(
      "",
      "Note: README.txt still describes your old level. It is generated documentation,",
      "not configuration — nothing reads it."
    );
  }

  return { from, to, noop, configEdits, secretsEdits, warnings, nextSteps, configText, secretsText };
}
