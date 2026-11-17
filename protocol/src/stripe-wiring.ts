import type { Finding } from "./config-lint";

/**
 * Stripe wiring probe — the one class of onboarding defect no file-level lint can see.
 *
 * Step 2 (create a restricted key, register a webhook endpoint) is a dashboard
 * click-path, so it is the least verified step in the runbook and the easiest to do
 * against the WRONG Stripe account. The failure is invisible locally: config.env,
 * secrets.env and .env.operator are all well-formed, the Coalition boots, `/health` is
 * green and checkout even succeeds — the sale just lands in someone else's account and
 * is relayed to MT by someone else's Coalition, under THEIR slug, claiming THEIR slot.
 *
 * Observed on staging 2026-08-18: a rental bought from `moltentech-test1` was minted in
 * MT's own platform account, fanned out to `coalition-test2`'s endpoint (registered in
 * that same account), relayed as `moltentech-test2`, and provisioned on test2's
 * hardware. Nothing in the operator's own files was wrong.
 *
 * Everything here CHANGES NOTHING in Stripe (`GET /v1/account`, `GET /v1/webhook_endpoints`,
 * and the permission probes below, which write to IDs that do not exist) and is opt-in behind
 * `doctor --check-stripe`, because it is the only check that needs the operator's secret in
 * memory.
 */

/** A webhook endpoint as this probe cares about it. */
export interface StripeEndpoint {
  url: string;
  status: string;
}

/**
 * Normalize for comparison: scheme+host+path, no trailing slash, case-folded host.
 * Flux serves every app on each of its gateway domains — `<app>.app.runonflux.io` and
 * `<app>.app2.runonflux.io` are the SAME Coalition — so the `appN` label folds to `app`.
 * Comparing them raw reported one Coalition as both FOREIGN and NOT_REGISTERED (prod,
 * 2026-10-04: endpoint on `app.`, COALITION_URL on `app2.`).
 */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.host.toLowerCase().replace(/^([^.]+)\.app\d*\.runonflux\.io$/, "$1.app.runonflux.io");
    return `${u.protocol}//${host}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return raw.trim().replace(/\/$/, "");
  }
}

/** Does this endpoint look like a Coalition's relay webhook (…/webhook)? */
function isCoalitionWebhook(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/$/, "") === "/webhook";
  } catch {
    return false;
  }
}

/** Does this endpoint look like MT's own first-party payment webhook? */
function isMtPlatformWebhook(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/$/, "") === "/api/payment/webhook";
  } catch {
    return false;
  }
}

/**
 * The pure half: given the endpoints registered in the account this key opens, and the
 * operator's own COALITION_URL, decide what is wrong. Separated from the fetching so it
 * can be tested without a network or a key.
 */
export function classifyEndpoints(
  endpoints: StripeEndpoint[],
  coalitionUrl: string,
  /**
   * Which mode the listing key opens. Stripe keeps test and live endpoints in SEPARATE
   * sets, and a key only ever sees its own — so "not registered" without the mode sends an
   * operator hunting in the wrong half of the dashboard for something that was never
   * missing. Optional so existing callers are unaffected.
   */
  mode?: "test" | "live"
): Finding[] {
  const findings: Finding[] = [];
  const mine = normalizeUrl(`${coalitionUrl.replace(/\/$/, "")}/webhook`);
  const enabled = endpoints.filter((e) => e.status === "enabled");

  // 1. The account is MT's, not the operator's. This is the root defect: every sale
  //    this Coalition mints is created in MT's books, and MT's own webhook sees it too.
  if (enabled.some((e) => isMtPlatformWebhook(e.url))) {
    findings.push({
      rule: "STRIPE_KEY_IS_MT_PLATFORM_ACCOUNT",
      severity: "error",
      file: "secrets.env",
      message:
        "STRIPE_SECRET_KEY opens an account that has Flux Hub's own payment webhook " +
        "registered in it — this is the platform's account, not yours. Sales you mint " +
        "land in its books. Create a restricted key in YOUR OWN Stripe account.",
    });
  }

  // 2. Another operator's Coalition is registered here. Stripe fans every event out to
  //    all endpoints, and a Coalition relays what it receives under its OWN slug — so
  //    that operator's Coalition will claim YOUR sale onto THEIR hardware.
  const foreign = enabled.filter((e) => isCoalitionWebhook(e.url) && normalizeUrl(e.url) !== mine);
  for (const e of foreign) {
    findings.push({
      rule: "STRIPE_WEBHOOK_FOREIGN_COALITION",
      severity: "error",
      file: "secrets.env",
      message:
        `${e.url} is a DIFFERENT Coalition's webhook registered in the same Stripe account. ` +
        "Stripe delivers every event to every endpoint, and a Coalition relays what it " +
        "receives under its OWN providerSlug — so a sale of yours gets claimed onto that " +
        "provider's hardware. ⚠️ This holds even when both Coalitions are YOURS: the damage " +
        "is done by the slug in the relay, not by who owns the account. One Stripe account " +
        "per provider.",
    });
  }

  // 3. Your own endpoint is missing, so you never hear about your own sales: checkout
  //    succeeds, the customer is charged, and no rental is ever relayed to MT.
  if (!enabled.some((e) => normalizeUrl(e.url) === mine)) {
    const disabled = endpoints.find((e) => normalizeUrl(e.url) === mine);
    // Naming the mode matters: this list only ever contains endpoints of the SAME mode as
    // the key that read it, so an endpoint created in the other half of the dashboard is
    // invisible here rather than absent. Without that sentence the finding reads as "you
    // never made one", which is the wrong thing to go and do.
    const inMode = mode ? ` ${mode.toUpperCase()}-mode` : "";
    const modeNote = mode
      ? ` Your key is ${mode}-mode, so only${inMode} endpoints are visible here — if you ` +
        `created yours in ${mode === "test" ? "Live" : "Test"} mode it will not appear, and ` +
        "it also would not fire for this key. Test and live are separate endpoints with " +
        "separate signing secrets."
      : "";
    findings.push({
      rule: "STRIPE_WEBHOOK_NOT_REGISTERED",
      severity: "error",
      file: "secrets.env",
      message: disabled
        ? `${mine} is registered but its status is "${disabled.status}", not "enabled".`
        : `${mine} is not registered as a${inMode} webhook endpoint in this Stripe account. ` +
          `Checkout will succeed, the customer is charged, and no rental ever reaches Flux Hub.${modeNote}`,
    });
  }

  return findings;
}

/**
 * The key permissions the Coalition uses, one probe each.
 *
 * A key built from the runbook's "Recurring subscriptions" preset has them all. A key built by
 * hand may not, and nothing else notices until a customer hits the missing one: prod 2026-11-16
 * had Subscriptions write but neither Customers nor Payment Methods, which Coalition 0.14.1
 * needs to keep one saved copy of each card.
 *
 * Each probe is a WRITE (or, for a Read permission, a GET) to an ID that cannot exist
 * (`…_fhprobe…`). A key holding the permission gets 404 `resource_missing`; a key without it gets
 * 403 `more_permissions_required` before Stripe looks the ID up. Nothing is created or changed
 * either way. Measured on the staging test key (preset): all 404; a GET the prod key lacked
 * (Refunds) 403, 2026-11-17.
 *
 * Invoices Read: prod 2026-11-17 lacked it, and the first live "join my bill" failed after the
 * line was already added (the join reads back what the move charged).
 */
export interface KeyPermission {
  /** As the Stripe dashboard names it. */
  name: string;
  path: (mode: "test" | "live") => string;
  /** What breaks without it, for the finding. */
  uses: string;
  severity: "error" | "warning";
  /** The level the Coalition needs; a Read permission is probed with a GET. Absent = Write. */
  level?: "Read" | "Write";
}

export const KEY_PERMISSIONS: KeyPermission[] = [
  { name: "Checkout Sessions", path: (m) => `/v1/checkout/sessions/cs_${m}_fhprobe0/expire`, uses: "card checkout", severity: "error" },
  { name: "Subscriptions", path: () => "/v1/subscriptions/sub_fhprobe0", uses: "subscriptions and each node's line on a bill (add a node, end a node, coupon price changes)", severity: "error" },
  { name: "Prices", path: () => "/v1/prices/price_fhprobe0", uses: "tier and coupon prices", severity: "error" },
  { name: "Products", path: () => "/v1/products/prod_fhprobe0", uses: "the product behind a coupon price", severity: "error" },
  { name: "Customer portal", path: () => "/v1/billing_portal/configurations/bpc_fhprobe0", uses: "the customer's card + invoices page", severity: "error" },
  { name: "Customers", path: () => "/v1/customers/cus_fhprobe0", uses: "keeping one saved copy of each card (moves the customer's default card)", severity: "warning" },
  { name: "Payment Methods", path: () => "/v1/payment_methods/pm_fhprobe0/detach", uses: "keeping one saved copy of each card (removes the copies)", severity: "warning" },
  { name: "Invoices", level: "Read", path: () => "/v1/invoices/in_fhprobe0", uses: "\"join my monthly bill\" (reads what the move charged)", severity: "error" },
];

/** The pure half of the permission check: one probe's answer → a finding, or none. */
export function classifyPermission(perm: KeyPermission, status: number, detail?: string): Finding | null {
  if ((status >= 200 && status < 300) || status === 404) return null;
  if (status === 403) {
    const level = perm.level ?? "Write";
    return {
      rule: "STRIPE_KEY_PERMISSION_MISSING",
      severity: perm.severity,
      file: "secrets.env",
      summary: `Stripe key lacks ${perm.name}: ${level} — set it on the key in the Stripe dashboard`,
      message:
        `STRIPE_SECRET_KEY does not have "${perm.name}" set to ${level}. The Coalition uses it for ${perm.uses}. ` +
        `In the Stripe dashboard → Developers → API keys, edit this restricted key and set it to ${level} ` +
        "(the \"Recurring subscriptions\" preset sets every permission the Coalition needs).",
    };
  }
  return {
    rule: "STRIPE_KEY_PERMISSION_UNVERIFIED",
    severity: "warning",
    file: "secrets.env",
    message: `could not check "${perm.name}" on STRIPE_SECRET_KEY (${status}: ${detail ?? "no detail"}) — NOT verified.`,
  };
}

/** Stripe POST with no body — only ever aimed at IDs that do not exist (see KEY_PERMISSIONS). */
async function stripePost(key: string, path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** Read-only Stripe GET with the operator's key. */
async function stripeGet(key: string, path: string): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
    signal: AbortSignal.timeout(15_000),
  });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
}

/**
 * Is this MT_BASE_URL the PRODUCTION hub?
 *
 * Decided on the parsed hostname, never a substring match. This gates a real-money check,
 * so the predecessor is worth naming: it was
 *
 *     /(^|\/\/)(www\.)?moltentech\.us/.test(url) && !/staging/.test(url)
 *
 * which read `fluxhub.moltentech.us` — the canonical hub since 2026-09-02 — as NOT
 * production, and that inverted BOTH branches at once: a LIVE key against production
 * became a false error telling the operator their correct setup would charge real money,
 * and a TEST key against production stopped warning at all. A substring test cannot
 * survive the host it hardcodes being renamed.
 *
 * An unrecognised host is deliberately NOT production. That direction fails LOUD rather
 * than silent: a live key against an unknown host raises the error, instead of a live key
 * being waved through because the hostname happened to contain "moltentech.us".
 *
 * ⚠️ Add the new name here when the canonical hub hostname changes.
 */
const PROD_HUB_HOSTS = new Set([
  "fluxhub.moltentech.us", // canonical since 2026-09-02
  "www.moltentech.us",     // transitional alias; 301s to fluxhub once the fleet has moved
  "moltentech.us",         // bare apex; redirects to fluxhub at the Cloudflare edge
]);

export function isProdHub(mtBaseUrl: string): boolean {
  // Tolerate a bare host with no scheme — the old regex matched those, and config files
  // in the wild carry them.
  const withScheme = /:\/\//.test(mtBaseUrl) ? mtBaseUrl : `https://${mtBaseUrl}`;
  try {
    return PROD_HUB_HOSTS.has(new URL(withScheme).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Probe the live account. Returns findings only — never throws, because `doctor` must
 * still report its file-level results when Stripe is unreachable.
 */
export async function probeStripeWiring(args: {
  stripeSecretKey: string;
  coalitionUrl: string;
  mtBaseUrl?: string;
}): Promise<Finding[]> {
  const { stripeSecretKey, coalitionUrl, mtBaseUrl } = args;
  const findings: Finding[] = [];

  // Mode mismatch, and the two directions are NOT the same finding.
  //
  // A test key against production is a legitimate place to stand: the runbook tells you to
  // sandbox with an `rk_test_` first, and a real operator onboards against prod because
  // that is where their provider record lives. Reporting it as an error made `doctor` exit
  // 1 through the whole of a step operators are supposed to take, which teaches them that
  // a red report is normal — the one habit this tool cannot afford to build.
  //
  // A LIVE key anywhere else stays an error, because that one charges real money on a
  // test rental. Same rule name, opposite blast radius: unsettled test payments are
  // recoverable, a real charge is not.
  const isTestKey = /^(sk|rk)_test_/.test(stripeSecretKey);
  if (mtBaseUrl) {
    const mtIsProd = isProdHub(mtBaseUrl);
    if (mtIsProd && isTestKey) {
      findings.push({
        rule: "STRIPE_KEY_MODE_MISMATCH",
        severity: "warning",
        file: "secrets.env",
        summary: "TEST Stripe key against production — fine while you sandbox, swap it before you list",
        message:
          `STRIPE_SECRET_KEY is a TEST key but MT_BASE_URL is production (${mtBaseUrl}). ` +
          "Expected while you are sandboxing — checkout works end to end and no real payment " +
          "ever settles. Before you take a real customer, swap in the live `rk_live_` key AND " +
          "the `whsec_` from the LIVE-mode endpoint: the two are independent, and a live key " +
          "with a test-mode webhook secret fails silently.",
      });
    }
    if (!mtIsProd && !isTestKey) {
      findings.push({
        rule: "STRIPE_KEY_MODE_MISMATCH",
        severity: "error",
        file: "secrets.env",
        message: `STRIPE_SECRET_KEY is a LIVE key but MT_BASE_URL is ${mtBaseUrl}. A staging rental would charge real money.`,
      });
    }
  }

  let account: { ok: boolean; status: number; json: any };
  try {
    account = await stripeGet(stripeSecretKey, "/v1/account");
  } catch (err) {
    findings.push({
      rule: "STRIPE_UNREACHABLE",
      severity: "warning",
      file: "secrets.env",
      message: `could not reach Stripe (${(err as Error).message}) — wiring NOT verified.`,
    });
    return findings;
  }
  // 401 is the only status that means "this key is not accepted". Anything else —
  // in practice a 403 — means the key WORKS and merely cannot read this endpoint, so
  // the probe must carry on to the endpoint check rather than stop at the door.
  //
  // Measured on the pve50 cold run: a RESTRICTED key (`rk_…`), which is what the
  // runbook tells operators to create, lacks `accounts_kyc_basic_read` by default, so
  // `/v1/account` 403s. Treating that as a rejected key reported a FALSE error and
  // returned early, skipping `classifyEndpoints` entirely — and on that run the skipped
  // check was hiding a real defect (the webhook still pointed at a stale Coalition URL).
  // Nothing below reads `account`; it was only ever a liveness probe.
  if (account.status === 401) {
    findings.push({
      rule: "STRIPE_KEY_INVALID",
      severity: "error",
      file: "secrets.env",
      message: `Stripe rejected STRIPE_SECRET_KEY (401: ${account.json?.error?.message ?? "no detail"}).`,
    });
    return findings;
  }
  // A 403 here is the EXPECTED answer for a key built to the runbook, which grants no
  // account-read permission at all — and nothing below reads `account`; it exists only to
  // separate "key rejected" (401) from "key works". Warning about it asked the operator to
  // widen a key's permissions to silence a check whose result is discarded, which is how a
  // report teaches people to skim it. Anything OTHER than 403 is still worth surfacing,
  // because then the call failed for a reason nobody has accounted for.
  if (!account.ok && account.status !== 403) {
    findings.push({
      rule: "STRIPE_ACCOUNT_UNREADABLE",
      severity: "warning",
      file: "secrets.env",
      message:
        `could not read the Stripe account (${account.status}: ${account.json?.error?.message ?? "no detail"}) — ` +
        "the key was not rejected, so the webhook checks below still ran. This call is only a " +
        "liveness probe; nothing depends on its result.",
    });
  }

  for (const perm of KEY_PERMISSIONS) {
    try {
      const path = perm.path(isTestKey ? "test" : "live");
      const r = perm.level === "Read" ? await stripeGet(stripeSecretKey, path) : await stripePost(stripeSecretKey, path);
      const f = classifyPermission(perm, r.status, r.json?.error?.message);
      if (f) findings.push(f);
    } catch (err) {
      const f = classifyPermission(perm, 0, (err as Error).message);
      if (f) findings.push(f);
    }
  }

  const eps = await stripeGet(stripeSecretKey, "/v1/webhook_endpoints?limit=100");
  if (!eps.ok) {
    findings.push({
      rule: "STRIPE_ENDPOINTS_UNREADABLE",
      severity: "warning",
      file: "secrets.env",
      summary:
        "the webhook check DID NOT RUN — grant this key Webhook Endpoints: Read, then re-run",
      message:
        `could not list webhook endpoints (${eps.status}: ${eps.json?.error?.message ?? "no detail"}). ` +
        "This is the check --check-stripe exists for, and it did NOT run: nothing here " +
        "verified that your webhook endpoint is on YOUR Stripe account rather than someone " +
        "else's. Grant this key the read-only \"Webhook Endpoints\" permission " +
        "(`webhook_read`) in the Stripe dashboard, then run it again. Until then the wiring " +
        "is UNVERIFIED — not verified-good.",
    });
    return findings;
  }

  const endpoints: StripeEndpoint[] = (eps.json?.data ?? []).map((e: any) => ({
    url: String(e.url ?? ""),
    status: String(e.status ?? ""),
  }));
  findings.push(...classifyEndpoints(endpoints, coalitionUrl, isTestKey ? "test" : "live"));
  return findings;
}
