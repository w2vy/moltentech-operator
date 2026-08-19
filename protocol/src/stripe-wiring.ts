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
 * Everything here is READ-ONLY against Stripe (`GET /v1/account`,
 * `GET /v1/webhook_endpoints`) and is opt-in behind `doctor --check-stripe`, because
 * it is the only check that needs the operator's secret in memory.
 */

/** A webhook endpoint as this probe cares about it. */
export interface StripeEndpoint {
  url: string;
  status: string;
}

/** Normalize for comparison: scheme+host+path, no trailing slash, case-folded host. */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, "")}`;
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
  coalitionUrl: string
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
        "STRIPE_SECRET_KEY opens an account that has MoltenTech's own payment webhook " +
        "registered in it — this is MT's platform account, not yours. Sales you mint " +
        "land in MT's books. Create a restricted key in YOUR OWN Stripe account.",
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
        `${e.url} is another Coalition's webhook registered in the same Stripe account. ` +
        "Stripe delivers every event to every endpoint, and a Coalition relays what it " +
        "receives under its own providerSlug — so that operator will claim your sale " +
        "onto their hardware. One Stripe account per operator.",
    });
  }

  // 3. Your own endpoint is missing, so you never hear about your own sales: checkout
  //    succeeds, the customer is charged, and no rental is ever relayed to MT.
  if (!enabled.some((e) => normalizeUrl(e.url) === mine)) {
    const disabled = endpoints.find((e) => normalizeUrl(e.url) === mine);
    findings.push({
      rule: "STRIPE_WEBHOOK_NOT_REGISTERED",
      severity: "error",
      file: "secrets.env",
      message: disabled
        ? `${mine} is registered but its status is "${disabled.status}", not "enabled".`
        : `${mine} is not registered as a webhook endpoint in this Stripe account. ` +
          "Checkout will succeed and no rental will ever reach MT.",
    });
  }

  return findings;
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

  // Mode mismatch is worth catching before anything else: a live key against staging
  // bills real money, and a test key against production silently never does.
  const isTestKey = /^(sk|rk)_test_/.test(stripeSecretKey);
  if (mtBaseUrl) {
    const mtIsProd = /(^|\/\/)(www\.)?moltentech\.us/.test(mtBaseUrl) && !/staging/.test(mtBaseUrl);
    if (mtIsProd && isTestKey) {
      findings.push({
        rule: "STRIPE_KEY_MODE_MISMATCH",
        severity: "error",
        file: "secrets.env",
        message: `STRIPE_SECRET_KEY is a TEST key but MT_BASE_URL is production (${mtBaseUrl}). No real payment will ever settle.`,
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
  if (!account.ok) {
    findings.push({
      rule: "STRIPE_KEY_INVALID",
      severity: "error",
      file: "secrets.env",
      message: `Stripe rejected STRIPE_SECRET_KEY (${account.status}: ${account.json?.error?.message ?? "no detail"}).`,
    });
    return findings;
  }

  const eps = await stripeGet(stripeSecretKey, "/v1/webhook_endpoints?limit=100");
  if (!eps.ok) {
    findings.push({
      rule: "STRIPE_ENDPOINTS_UNREADABLE",
      severity: "warning",
      file: "secrets.env",
      message:
        `could not list webhook endpoints (${eps.status}: ${eps.json?.error?.message ?? "no detail"}) — ` +
        "a restricted key needs read access to Webhook Endpoints for this check.",
    });
    return findings;
  }

  const endpoints: StripeEndpoint[] = (eps.json?.data ?? []).map((e: any) => ({
    url: String(e.url ?? ""),
    status: String(e.status ?? ""),
  }));
  findings.push(...classifyEndpoints(endpoints, coalitionUrl));
  return findings;
}
