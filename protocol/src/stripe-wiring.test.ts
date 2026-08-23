import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEndpoints, probeStripeWiring } from "./stripe-wiring";

const MINE = "https://coalition-test1.app.runonflux.io";
const rules = (fs: ReturnType<typeof classifyEndpoints>) => fs.map((f) => f.rule).sort();

test("a correctly wired account: only my own enabled endpoint", () => {
  assert.deepEqual(
    rules(classifyEndpoints([{ url: `${MINE}/webhook`, status: "enabled" }], MINE)),
    []
  );
});

test("reproduces the 2026-08-18 staging misroute: MT's platform account, my endpoint absent, a rival Coalition present", () => {
  const findings = classifyEndpoints(
    [
      { url: "https://coalition-test2.app.runonflux.io/webhook", status: "enabled" },
      { url: "https://coalition-other.app.runonflux.io/webhook", status: "enabled" },
      { url: "https://staging.moltentech.us/api/payment/webhook", status: "enabled" },
    ],
    MINE
  );
  assert.deepEqual(rules(findings), [
    "STRIPE_KEY_IS_MT_PLATFORM_ACCOUNT",
    "STRIPE_WEBHOOK_FOREIGN_COALITION",
    "STRIPE_WEBHOOK_FOREIGN_COALITION",
    "STRIPE_WEBHOOK_NOT_REGISTERED",
  ]);
  assert.ok(findings.every((f) => f.severity === "error"));
});

test("my endpoint registered but disabled is reported as not registered, and says so", () => {
  const findings = classifyEndpoints([{ url: `${MINE}/webhook`, status: "disabled" }], MINE);
  assert.deepEqual(rules(findings), ["STRIPE_WEBHOOK_NOT_REGISTERED"]);
  const only = findings[0];
  assert.ok(only, "expected exactly one finding");
  assert.match(only.message, /status is "disabled"/);
});

test("trailing slash and host case do not make my own endpoint look foreign", () => {
  assert.deepEqual(
    rules(
      classifyEndpoints(
        [{ url: "https://Coalition-Test1.app.runonflux.io/webhook/", status: "enabled" }],
        MINE
      )
    ),
    []
  );
});

test("a disabled rival Coalition is not flagged — Stripe delivers to enabled endpoints only", () => {
  assert.deepEqual(
    rules(
      classifyEndpoints(
        [
          { url: `${MINE}/webhook`, status: "enabled" },
          { url: "https://coalition-test2.app.runonflux.io/webhook", status: "disabled" },
        ],
        MINE
      )
    ),
    []
  );
});

/** The impure half. Stubs `fetch` rather than mocking a Stripe client, because the bug
 * being pinned here was in the control flow between two requests, not in either one. */
function withStubbedFetch(
  handler: (url: string) => { status: number; body: unknown },
  run: () => Promise<void>
): Promise<void> {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    const { status, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as any;
  }) as any;
  (withStubbedFetch as any).calls = calls;
  return run().finally(() => {
    globalThis.fetch = real;
  });
}

const MY_URL = "https://coalition-mine.app.runonflux.io";

/** Key fixtures carry a hyphen straight after the `rk_test_` prefix on purpose: gitleaks'
 * `stripe-access-token` rule needs 10+ alphanumerics after the prefix, so a fixture that
 * runs ten or more straight past it fails the full-history scan. Keep them un-key-shaped
 * rather than allowlisting a value — the scan stays strict for real keys. The value is
 * never inspected here anyway: the mode check is guarded by `mtBaseUrl`, which these
 * cases do not pass. */
const FAKE_RESTRICTED_KEY = "rk_test_fake-restricted";

/** Measured on the pve50 cold run 2026-08-19: a restricted key 403s on /v1/account
 * because it lacks `accounts_kyc_basic_read`, and the probe used to stop right there —
 * reporting a valid key as rejected AND skipping the endpoint rules, which on that run
 * were the only thing that would have caught a stale webhook URL. */
test("a 403 on /v1/account does not stop the probe — the endpoint checks still run", async () => {
  await withStubbedFetch(
    (url) =>
      url.includes("/v1/account")
        ? { status: 403, body: { error: { message: "Permission denied. …accounts_kyc_basic_read…" } } }
        : {
            status: 200,
            body: {
              data: [
                { url: "https://coalition-someone-else.app.runonflux.io/webhook", status: "enabled" },
              ],
            },
          },
    async () => {
      const findings = await probeStripeWiring({
        stripeSecretKey: FAKE_RESTRICTED_KEY,
        coalitionUrl: MY_URL,
      });
      const ruleNames = findings.map((f) => f.rule).sort();
      // ⭐ NOT reported (changed 2026-08-23). A 403 here is the expected answer for a key
      // built to the runbook, and nothing below reads `account` — the call only separates
      // 401 from "key works". Warning about it told the operator to widen a key's
      // permissions to silence a check whose result is thrown away.
      assert.ok(
        !ruleNames.includes("STRIPE_ACCOUNT_UNREADABLE"),
        "an expected 403 on a discarded liveness probe must not become a warning"
      );
      assert.ok(
        !ruleNames.includes("STRIPE_KEY_INVALID"),
        "a working key must never be reported as rejected"
      );
      // The whole point: the endpoint rules executed.
      assert.ok(ruleNames.includes("STRIPE_WEBHOOK_FOREIGN_COALITION"));
      assert.ok(ruleNames.includes("STRIPE_WEBHOOK_NOT_REGISTERED"));

    }
  );
});

test("a 401 on /v1/account still fails hard, and never reaches the endpoint list", async () => {
  let endpointsFetched = false;
  await withStubbedFetch(
    (url) => {
      if (url.includes("/v1/webhook_endpoints")) endpointsFetched = true;
      return url.includes("/v1/account")
        ? { status: 401, body: { error: { message: "Invalid API Key provided" } } }
        : { status: 200, body: { data: [] } };
    },
    async () => {
      const findings = await probeStripeWiring({
        stripeSecretKey: "rk_test_fake-bogus",
        coalitionUrl: MY_URL,
      });
      assert.deepEqual(
        findings.map((f) => f.rule),
        ["STRIPE_KEY_INVALID"]
      );
      assert.equal(findings[0]!.severity, "error");
      assert.equal(endpointsFetched, false);
    }
  );
});

test("a healthy account produces no account-level finding at all", async () => {
  await withStubbedFetch(
    (url) =>
      url.includes("/v1/account")
        ? { status: 200, body: { id: "acct_123" } }
        : { status: 200, body: { data: [{ url: `${MY_URL}/webhook`, status: "enabled" }] } },
    async () => {
      const findings = await probeStripeWiring({
        stripeSecretKey: "rk_test_fake-ok",
        coalitionUrl: MY_URL,
      });
      assert.deepEqual(findings, []);
    }
  );
});

test("⭐ a 403 on the ENDPOINT list says the check DID NOT RUN — not that wiring is fine", async () => {
  // Measured on prod 2026-08-23 with the runbook's own restricted key, which grants no
  // `webhook_read`: the endpoint comparison — the entire reason this flag exists, and the
  // only defence against the 08-18 misroute — was skipped, and the report ended "1
  // error(s), 2 warning(s)" as though the wiring had been looked at. Unverified must never
  // be presentable as verified-good.
  await withStubbedFetch(
    (url) =>
      url.includes("/v1/webhook_endpoints")
        ? { status: 403, body: { error: { message: "Permission denied. …webhook_read…" } } }
        : { status: 200, body: {} },
    async () => {
      const findings = await probeStripeWiring({
        stripeSecretKey: FAKE_RESTRICTED_KEY,
        coalitionUrl: MY_URL,
      });
      const only = findings.find((f) => f.rule === "STRIPE_ENDPOINTS_UNREADABLE")!;
      assert.ok(only, "expected the unreadable-endpoints warning");
      assert.match(only.summary!, /DID NOT RUN/);
      assert.match(only.summary!, /Webhook Endpoints: Read/);
      assert.match(only.message, /UNVERIFIED/);
      // and it must not have silently claimed anything about the wiring
      assert.equal(findings.some((f) => f.rule.startsWith("STRIPE_WEBHOOK_")), false);
    }
  );
});

test("a 403 on /v1/account is silent, because its result is discarded", async () => {
  await withStubbedFetch(
    (url) =>
      url.includes("/v1/account")
        ? { status: 403, body: { error: { message: "Permission denied. …accounts_kyc_basic_read…" } } }
        : { status: 200, body: { data: [{ url: `${MY_URL}/webhook`, status: "enabled" }] } },
    async () => {
      const findings = await probeStripeWiring({
        stripeSecretKey: FAKE_RESTRICTED_KEY,
        coalitionUrl: MY_URL,
      });
      assert.deepEqual(findings, [], "a correctly wired restricted key reports nothing at all");
    }
  );
});

test("a NON-403 account failure is still surfaced — that one nobody has accounted for", async () => {
  await withStubbedFetch(
    (url) =>
      url.includes("/v1/account")
        ? { status: 500, body: { error: { message: "internal" } } }
        : { status: 200, body: { data: [{ url: `${MY_URL}/webhook`, status: "enabled" }] } },
    async () => {
      const findings = await probeStripeWiring({
        stripeSecretKey: FAKE_RESTRICTED_KEY,
        coalitionUrl: MY_URL,
      });
      assert.deepEqual(findings.map((f) => f.rule), ["STRIPE_ACCOUNT_UNREADABLE"]);
    }
  );
});

/**
 * The two directions of a mode mismatch are not the same finding, and treating them alike
 * broke the step operators are told to take. Sandboxing with an `rk_test_` against prod is
 * the documented onboarding path — an operator's provider record lives on prod, so there is
 * nowhere else to stand — and reporting it as an error made `doctor` exit 1 for the whole
 * of that phase. A tool that is red while you follow its own instructions teaches you that
 * red means nothing.
 */
test("⭐ a TEST key against prod is a WARNING — sandboxing is a step, not a mistake", async () => {
  await withStubbedFetch(
    () => ({ status: 200, body: { data: [{ url: `${MY_URL}/webhook`, status: "enabled" }] } }),
    async () => {
      const findings = await probeStripeWiring({
        stripeSecretKey: "rk_test_fake",
        coalitionUrl: MY_URL,
        mtBaseUrl: "https://www.moltentech.us",
      });
      const f = findings.find((x) => x.rule === "STRIPE_KEY_MODE_MISMATCH")!;
      assert.ok(f, "still reported — it must not become invisible");
      assert.equal(f.severity, "warning");
      // It has to name what to do before going live, including the trap that the webhook
      // secret is a SEPARATE swap from the key.
      assert.match(f.message, /whsec_/);
      assert.match(f.summary!, /before you list/);
    }
  );
});

test("⭐ a LIVE key against staging stays an ERROR — that one charges real money", async () => {
  // Opposite blast radius: an unsettled test payment is recoverable, a real charge on a
  // test rental is not. Same rule name, deliberately different severity.
  await withStubbedFetch(
    () => ({ status: 200, body: { data: [{ url: `${MY_URL}/webhook`, status: "enabled" }] } }),
    async () => {
      const findings = await probeStripeWiring({
        stripeSecretKey: "rk_live_fake",
        coalitionUrl: MY_URL,
        mtBaseUrl: "https://staging.moltentech.us",
      });
      const f = findings.find((x) => x.rule === "STRIPE_KEY_MODE_MISMATCH")!;
      assert.equal(f.severity, "error");
      assert.match(f.message, /real money/);
    }
  );
});

test("a matched pair in either mode reports no mismatch at all", async () => {
  await withStubbedFetch(
    () => ({ status: 200, body: { data: [{ url: `${MY_URL}/webhook`, status: "enabled" }] } }),
    async () => {
      for (const [key, url] of [
        ["rk_live_fake", "https://www.moltentech.us"],
        ["rk_test_fake", "https://staging.moltentech.us"],
      ] as const) {
        const findings = await probeStripeWiring({ stripeSecretKey: key, coalitionUrl: MY_URL, mtBaseUrl: url });
        assert.deepEqual(findings, [], `${key} + ${url}`);
      }
    }
  );
});
