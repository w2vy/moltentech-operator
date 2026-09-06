import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readLevel,
  readEnvValue,
  readTierPrices,
  upsertEnvLine,
  setTierPrices,
  addStripeBlock,
  planLevelChange,
} from "./level-change";
import { renderSecretsEnv, type Answers } from "./scaffold";

/** The only fields renderSecretsEnv reads are the Stripe pair; the rest just has to typecheck. */
const ANSWERS: Answers = {
  providerSlug: "demo",
  providerName: "Demo",
  ownerAddress: "t1owner",
  mtBaseUrl: "https://hub.example",
  fluxAppName: "coalition-demo",
  hosts: [],
};

const CONFIG = `# a comment above
PROVIDER_SLUG=demo
PROVIDER_NAME=Demo

# PROVIDER_LEVEL — what you signed up as.
PROVIDER_LEVEL=supporter
HOSTS=pve-01
TIER_PRICES_JSON={}
TRIAL_DAYS=1
`;

test("readLevel distinguishes absent from supporter", () => {
  assert.equal(readLevel(CONFIG), "supporter");
  assert.equal(readLevel("PROVIDER_SLUG=demo\n"), undefined, "absent is a real third state");
  assert.equal(readLevel("PROVIDER_LEVEL=\n"), undefined, "empty is not a level");
  assert.equal(readLevel("PROVIDER_LEVEL=operator\n"), "operator");
});

test("⭐ a PROVIDER_LEVEL line with a trailing comment is a VALUE, not a level", () => {
  // `parseConfigEnv` takes everything after `=`, so this line's value really is
  // "supporter # for now" and the signing path will treat it that way. Trimming the
  // comment here would make `level` disagree with `sign` about what the file says;
  // doctor's CFG_INLINE_COMMENT is what tells the operator to fix it.
  assert.equal(readLevel("PROVIDER_LEVEL=supporter # for now\n"), undefined);
  assert.equal(readEnvValue("PROVIDER_LEVEL=supporter # for now\n", "PROVIDER_LEVEL"), "supporter # for now");
});

test("upsertEnvLine replaces in place, preserving position, comments and neighbours", () => {
  const out = upsertEnvLine(CONFIG, "PROVIDER_LEVEL", "operator");
  assert.match(out, /^PROVIDER_LEVEL=operator$/m);
  assert.equal(out.split("\n").length, CONFIG.split("\n").length, "no lines added or removed");
  assert.equal(
    out.split("\n").indexOf("PROVIDER_LEVEL=operator"),
    CONFIG.split("\n").indexOf("PROVIDER_LEVEL=supporter"),
    "the line stayed where it was"
  );
  assert.match(out, /# PROVIDER_LEVEL — what you signed up as\./, "its comment survived");
  assert.match(out, /^PROVIDER_SLUG=demo$/m, "unrelated lines untouched");
});

test("upsertEnvLine appends an absent key, with each comment on its OWN line", () => {
  // Correctness, not style: a trailing `# note` becomes part of the value.
  const out = upsertEnvLine("A=1\n", "B", "2", ["why B exists", "and a second line"]);
  assert.equal(out, "A=1\n# why B exists\n# and a second line\nB=2\n");
  for (const line of out.split("\n")) {
    if (line.includes("=")) assert.ok(!/\s#/.test(line), `value line carries a comment: ${line}`);
  }
});

test("applying twice is identical to applying once", () => {
  const once = upsertEnvLine(CONFIG, "PROVIDER_LEVEL", "operator");
  assert.equal(upsertEnvLine(once, "PROVIDER_LEVEL", "operator"), once);
  const priced = setTierPrices(once, { cumulus: 2500 });
  assert.equal(setTierPrices(priced, { cumulus: 2500 }), priced);
});

test("readTierPrices tolerates anything unusable rather than throwing", () => {
  assert.deepEqual(readTierPrices('TIER_PRICES_JSON={"cumulus":700}\n'), { cumulus: 700 });
  assert.deepEqual(readTierPrices("TIER_PRICES_JSON={}\n"), {});
  assert.deepEqual(readTierPrices("TIER_PRICES_JSON=not json\n"), {});
  assert.deepEqual(readTierPrices("TIER_PRICES_JSON=[1,2]\n"), {}, "an array is not a price map");
  assert.deepEqual(readTierPrices("PROVIDER_SLUG=demo\n"), {});
});

test("⭐ an upgraded secrets.env is byte-identical to a natively generated Operator one", () => {
  // The reason `addStripeBlock` reuses renderSecretsEnv's exact comment text. If the two
  // ever drift, an upgraded operator's file quietly stops matching the documented one and
  // no test would otherwise notice.
  const supporter = renderSecretsEnv(ANSWERS, { includeStripe: false, sessionSecret: "s".repeat(64) });
  const native = renderSecretsEnv(
    { ...ANSWERS, stripeSecretKey: "rk_test_x", stripeWebhookSecret: "" },
    { includeStripe: true, sessionSecret: "s".repeat(64) }
  );
  const upgraded = addStripeBlock(supporter, { secretKey: "rk_test_x" });
  assert.equal(upgraded, native);
});

test("addStripeBlock never blanks keys that are already set", () => {
  const existing = "STRIPE_SECRET_KEY=rk_live_keep\nSTRIPE_WEBHOOK_SECRET=whsec_keep\n";
  assert.equal(addStripeBlock(existing, {}), existing, "no values given, nothing changed");
  const out = addStripeBlock(existing, { secretKey: "rk_live_new" });
  assert.match(out, /^STRIPE_SECRET_KEY=rk_live_new$/m);
  assert.match(out, /^STRIPE_WEBHOOK_SECRET=whsec_keep$/m, "the webhook secret Stripe showed once");
});

test("planLevelChange going up: level, prices and Stripe, and nothing else", () => {
  const plan = planLevelChange({
    configText: CONFIG,
    secretsText: renderSecretsEnv(ANSWERS, { includeStripe: false, sessionSecret: "s".repeat(64) }),
    target: "operator",
    prices: { cumulus: 2500 },
    stripe: { secretKey: "rk_test_x" },
    hubBaseUrl: "https://hub.example",
  });
  assert.equal(plan.from, "supporter");
  assert.equal(plan.noop, false);
  assert.match(plan.configText, /^PROVIDER_LEVEL=operator$/m);
  assert.match(plan.configText, /^TIER_PRICES_JSON=\{"cumulus":2500\}$/m);
  assert.match(plan.secretsText, /^STRIPE_SECRET_KEY=rk_test_x$/m);
  assert.match(plan.nextSteps.join("\n"), /https:\/\/hub\.example\/onboard/, "the operator's own hub");
  assert.match(plan.nextSteps.join("\n"), /README\.txt/, "says out loud what it did not regenerate");
});

test("planLevelChange going down keeps the Stripe keys and warns about what it cannot see", () => {
  const up = planLevelChange({
    configText: CONFIG,
    secretsText: renderSecretsEnv(ANSWERS, { includeStripe: false, sessionSecret: "s".repeat(64) }),
    target: "operator",
    prices: { cumulus: 2500 },
    stripe: { secretKey: "rk_test_x", webhookSecret: "whsec_x" },
  });
  const down = planLevelChange({
    configText: up.configText,
    secretsText: up.secretsText,
    target: "supporter",
  });
  assert.match(down.configText, /^PROVIDER_LEVEL=supporter$/m);
  assert.match(down.configText, /^TIER_PRICES_JSON=\{\}$/m);
  assert.equal(down.secretsText, up.secretsText, "secrets.env is not touched on the way down");
  assert.match(down.warnings.join(" "), /cannot see your live rentals/);
  assert.match(down.warnings.join(" "), /Stripe keys are left in place/);

  // And back up without re-entering Stripe: the keys are still there.
  const again = planLevelChange({
    configText: down.configText,
    secretsText: down.secretsText,
    target: "operator",
    prices: { cumulus: 2500 },
  });
  assert.match(again.configText, /^PROVIDER_LEVEL=operator$/m);
  assert.equal(again.secretsText, down.secretsText, "no Stripe re-prompt was needed");
});

test("planLevelChange reports a no-op rather than rewriting an already-correct file", () => {
  const done = planLevelChange({
    configText: CONFIG.replace("PROVIDER_LEVEL=supporter", "PROVIDER_LEVEL=operator").replace(
      "TIER_PRICES_JSON={}",
      'TIER_PRICES_JSON={"cumulus":2500}'
    ),
    secretsText: "STRIPE_SECRET_KEY=rk_x\nSTRIPE_WEBHOOK_SECRET=whsec_x\n",
    target: "operator",
  });
  assert.equal(done.noop, true);
  assert.deepEqual(done.configEdits, []);
});

test("an absent PROVIDER_LEVEL is warned about, because absent reads as operator downstream", () => {
  const plan = planLevelChange({
    configText: "PROVIDER_SLUG=demo\nTIER_PRICES_JSON={}\n",
    secretsText: "",
    target: "supporter",
  });
  assert.equal(plan.from, undefined);
  assert.match(plan.warnings.join(" "), /declares no PROVIDER_LEVEL/);
  assert.match(plan.configText, /^PROVIDER_LEVEL=supporter$/m);
});

test("an operator with no prices is flagged in the plan, not silently written", () => {
  const plan = planLevelChange({ configText: CONFIG, secretsText: "", target: "operator" });
  assert.match(plan.warnings.join(" "), /LEVEL_OPERATOR_NO_TIERS/);
});
