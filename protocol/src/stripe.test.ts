import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCommand, CliError } from "./cli";
import { readEnvValue, readTierPrices, readListing } from "./level-change";
import { renderConfigEnv } from "./scaffold";
import { ANSWERS, ctxFor, fakeFetch, keyedDir, quiet, scaffolded } from "./cli-harness";

/**
 * `fh-toolkit stripe` — prices + keys, the three "for sale" files, no level semantics.
 * `level --set operator` is this plus the level line; `level.test.ts` is that gate.
 */

test("existing: a price change lands in config.env AND the agent's listing; the manifest is named as stale", async () => {
  const dir = await scaffolded();
  const { result, log } = await quiet(() =>
    runCommand("stripe", ["--dir", dir, "--price", "cumulus=9", "--price", "nimbus=12", "--yes"], { dir, interactive: false, fetch: fakeFetch() })
  );
  assert.equal(result, 0);
  const config = readFileSync(join(dir, "config.env"), "utf8");
  assert.deepEqual(readTierPrices(config), { cumulus: 900, nimbus: 1200 });
  const listing = readListing(readFileSync(join(dir, ".env.operator"), "utf8"));
  assert.deepEqual(listing, [
    { tier: "cumulus", priceCents: 900, availableSlots: 2 },
    { tier: "nimbus", priceCents: 1200, availableSlots: 0 },
  ]);
  assert.ok(existsSync(join(dir, "config.env.bak")));
  assert.match(log, /TIER_PRICES_JSON is in your SIGNED manifest/);
  assert.match(log, /force-recreate/);
  assert.equal(readEnvValue(readFileSync(join(dir, "secrets.env"), "utf8"), "STRIPE_SECRET_KEY"), "rk_test_old", "keys untouched when not given");
});

test("the webhook secret alone: one line in secrets.env, nothing else moves", async () => {
  const dir = await scaffolded();
  const configBefore = readFileSync(join(dir, "config.env"), "utf8");
  const operatorBefore = readFileSync(join(dir, ".env.operator"), "utf8");
  const { result } = await quiet(() =>
    runCommand("stripe", ["--dir", dir, "--stripe-webhook", "whsec_abc", "--yes"], { dir, interactive: false, fetch: fakeFetch() })
  );
  assert.equal(result, 0);
  assert.equal(readEnvValue(readFileSync(join(dir, "secrets.env"), "utf8"), "STRIPE_WEBHOOK_SECRET"), "whsec_abc");
  assert.equal(readFileSync(join(dir, "config.env"), "utf8"), configBefore);
  assert.equal(readFileSync(join(dir, ".env.operator"), "utf8"), operatorBefore);
});

test("fresh secrets.env: the init skeleton with MANIFEST_KEY and SESSION_SECRET filled, plus the Stripe block", async () => {
  const dir = await scaffolded();
  rmSync(join(dir, "secrets.env"));
  const { result, log } = await quiet(() =>
    runCommand("stripe", ["--dir", dir, "--stripe-key", "rk_test_new", "--yes"], { dir, interactive: false, fetch: fakeFetch() })
  );
  assert.equal(result, 0);
  const secrets = readFileSync(join(dir, "secrets.env"), "utf8");
  assert.equal(readEnvValue(secrets, "STRIPE_SECRET_KEY"), "rk_test_new");
  assert.ok(readEnvValue(secrets, "MANIFEST_KEY"));
  assert.match(readEnvValue(secrets, "SESSION_SECRET") ?? "", /^[0-9a-f]{64}$/);
  assert.equal(readEnvValue(secrets, "COALITION_SIGNING_KEY"), "", "still the /onboard flow's to issue");
  assert.match(log, /new file/);
});

test("a below-floor or unknown-tier --price is refused and nothing is written", async () => {
  const dir = await scaffolded();
  const before = readFileSync(join(dir, "config.env"), "utf8");
  await assert.rejects(
    runCommand("stripe", ["--dir", dir, "--price", "cumulus=1", "--yes"], { dir, interactive: false, fetch: fakeFetch() }),
    (e: unknown) => e instanceof CliError && /below the \$2\.50 floor/.test(e.message)
  );
  await assert.rejects(
    runCommand("stripe", ["--dir", dir, "--price", "mega=99", "--yes"], { dir, interactive: false, fetch: fakeFetch() }),
    (e: unknown) => e instanceof CliError && /unknown tier/.test(e.message)
  );
  assert.equal(readFileSync(join(dir, "config.env"), "utf8"), before);
});

test("--dry-run prints the diff and writes nothing; an identical run is a noop", async () => {
  const dir = await scaffolded();
  const before = readFileSync(join(dir, "config.env"), "utf8");
  const dry = await quiet(() => runCommand("stripe", ["--dir", dir, "--price", "cumulus=9", "--dry-run"], { dir, interactive: false, fetch: fakeFetch() }));
  assert.equal(dry.result, 0);
  assert.match(dry.log, /TIER_PRICES_JSON: \{"cumulus":700\} → \{"cumulus":900\}/);
  assert.match(dry.log, /nothing written/);
  assert.equal(readFileSync(join(dir, "config.env"), "utf8"), before);
  const same = await quiet(() => runCommand("stripe", ["--dir", dir, "--price", "cumulus=7", "--yes"], { dir, interactive: false, fetch: fakeFetch() }));
  assert.match(same.log, /Already priced and wired/);
});

test("a supporter's prices are written with a warning that nothing is for sale until `level`", async () => {
  const dir = keyedDir();
  writeFileSync(join(dir, "config.env"), renderConfigEnv({ ...ANSWERS, level: "supporter", tierPricesCents: {}, hosts: [] }));
  const { result, log } = await quiet(() => runCommand("stripe", ["--dir", dir, "--price", "cumulus=5", "--yes"], { dir, interactive: false, fetch: fakeFetch() }));
  assert.equal(result, 0);
  assert.deepEqual(readTierPrices(readFileSync(join(dir, "config.env"), "utf8")), { cumulus: 500 });
  assert.match(log, /PROVIDER_LEVEL is supporter .* until `fh-toolkit level --set operator`/);
  assert.match(log, /no \.env\.operator here/);
});

test("interactive: the same questions `init` asks a seller, floors from the hub", async () => {
  const dir = await scaffolded();
  // tiers → price cumulus → price nimbus → stripe key → webhook
  const { ctx, transcript } = ctxFor(dir, ["cumulus,nimbus", "8", "", "rk_test_int", ""]);
  const { result } = await quiet(() => runCommand("stripe", ["--dir", dir], ctx));
  assert.equal(result, 0);
  assert.match(transcript(), /floor \$2\.50/);
  assert.match(transcript(), /floor \$7\.00/);
  assert.deepEqual(readTierPrices(readFileSync(join(dir, "config.env"), "utf8")), { cumulus: 800, nimbus: 700 });
  assert.equal(readEnvValue(readFileSync(join(dir, "secrets.env"), "utf8"), "STRIPE_SECRET_KEY"), "rk_test_int");
});
