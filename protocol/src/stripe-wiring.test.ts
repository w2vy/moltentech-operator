import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEndpoints } from "./stripe-wiring";

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
