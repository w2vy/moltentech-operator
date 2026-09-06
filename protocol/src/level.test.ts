import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderManifestBody, ProviderManifest } from "./manifest";
import { renderManifestBodyFromConfig } from "./manifest-config";
import { verifyManifestObject, canonicalize } from "./signing";
import { isSelling, renderConfigEnv, type Answers } from "./scaffold";
import { runDoctor } from "./config-lint";

/**
 * Flux Hub has two levels of participation, and until now only one of them had a name.
 *
 *   supporter — runs their own nodes and lends idle capacity for Foundation nodes.
 *               Sells nothing; needs no Stripe account.
 *   operator  — the above, plus hardware rented out through the marketplace.
 *
 * The level is DECLARED in the signed manifest, so FH reads an explicit answer rather
 * than inferring one from "has tiers" — an inference that flips the moment a supporter
 * adds a tier, with nothing recording what they meant.
 */

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

const BASE: Answers = {
  providerSlug: "level-test",
  providerName: "Level Test",
  ownerAddress: "t1owner",
  mtBaseUrl: "https://127.0.0.1:1",
  fluxAppName: "coalition-level-test",
  hosts: [
    {
      name: "pve-01",
      storageImages: "ssd",
      storageIso: "iso-store",
      slots: [
        {
          tier: "cumulus",
          vmName: "lt-c1",
          ipAddress: "203.0.113.10",
          lanIp: "192.168.1.10/24",
          gateway: "192.168.1.1",
          apiPort: 16127,
        },
      ],
    },
  ],
};

test("a supporter sells nothing; an operator does; an explicit answer still wins", () => {
  assert.equal(isSelling({ ...BASE, level: "supporter" }), false);
  assert.equal(isSelling({ ...BASE, level: "operator" }), true);
  assert.equal(isSelling(BASE), true, "absent level means operator — what every provider is today");
  assert.equal(isSelling({ ...BASE, level: "supporter", selling: true }), true, "explicit selling wins");
});

test("PROVIDER_LEVEL reaches config.env, and from there the signed manifest", () => {
  const config = renderConfigEnv({ ...BASE, level: "supporter" });
  assert.match(config, /^PROVIDER_LEVEL=supporter$/m);
  const body = renderManifestBodyFromConfig(config + "\nHOSTS=pve-01\n");
  assert.equal(body.level, "supporter");
  // `sign` fills pubkey + publishedAt; the body renderer does not, so supply them here.
  const parsed = ProviderManifestBody.parse({
    ...body,
    pubkey: "PUBKEY",
    publishedAt: "2026-08-22T00:00:00.000Z",
  });
  assert.equal(parsed.level, "supporter");
});

test("a garbage PROVIDER_LEVEL is refused at render time, not silently dropped", () => {
  const config = renderConfigEnv(BASE).replace(/^PROVIDER_LEVEL=.*$/m, "PROVIDER_LEVEL=sponsor");
  assert.throws(() => renderManifestBodyFromConfig(config + "\nHOSTS=pve-01\n"), /PROVIDER_LEVEL/);
});

test("🔴 a legacy manifest with no level still validates — and still VERIFIES", () => {
  // The signature is checked against the RAW object, so an optional field the schema
  // knows about cannot change the bytes of a manifest signed before it existed. If this
  // ever fails, someone made `level` required or gave it a zod default, and every
  // provider onboarded before today is now unverifiable.
  const dir = mkdtempSync(join(tmpdir(), "mt-level-"));
  writeFileSync(
    join(dir, "config.env"),
    [
      "PROVIDER_SLUG=legacy-op",
      "PROVIDER_NAME=Legacy Operator",
      "COALITION_URL=https://coalition-legacy.app.runonflux.io",
      "HOSTS=pve-01",
      "TRIAL_DAYS=1",
    ].join("\n") + "\n"
  );
  execFileSync(process.execPath, ["--import", "tsx", CLI, "keygen", "--out", dir], { stdio: "ignore" });
  execFileSync(
    process.execPath,
    [
      "--import", "tsx", CLI, "sign",
      "--key", join(dir, "manifest-key.pem"),
      "--from-config", join(dir, "config.env"),
      "--out", join(dir, "manifest.json"),
    ],
    { stdio: "ignore" }
  );
  const raw = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal("level" in raw, false, "an unset level must not be emitted at all");
  assert.equal(verifyManifestObject(raw), true);

  const parsed = ProviderManifest.parse(raw);
  assert.equal(parsed.level, undefined);
  // The parsed body must canonicalize to the same bytes as the raw one: that equality is
  // exactly what a zod default would break.
  const { signature: _s, ...rawBody } = raw;
  const { signature: _p, ...parsedBody } = parsed as Record<string, unknown>;
  assert.equal(canonicalize(parsedBody), canonicalize(rawBody));
});

test("doctor stops nagging a supporter about Stripe keys they will never have", () => {
  const secrets = "STRIPE_SECRET_KEY=\nSTRIPE_WEBHOOK_SECRET=\nAGENT_KEY=\n";
  const asOperator = runDoctor({ configEnv: "PROVIDER_LEVEL=operator\n", secretsEnv: secrets });
  const asSupporter = runDoctor({ configEnv: "PROVIDER_LEVEL=supporter\n", secretsEnv: secrets });
  assert.equal(asOperator.findings.filter((f) => f.message.includes("STRIPE")).length, 2);
  assert.equal(asSupporter.findings.filter((f) => f.message.includes("STRIPE")).length, 0);
  // ...but the key another system really does issue is still reported for both.
  for (const r of [asOperator, asSupporter]) {
    assert.ok(r.findings.some((f) => f.message.startsWith("AGENT_KEY is empty")));
  }
});

// ── `level`: the Supporter → Operator upgrade, end to end ────────────────────
// The promise in operator-onboarding.md was "upgrading later is a simple process". These
// assert the two halves of making that true: the change lands, and everything ELSE in the
// directory is byte-identical afterwards — the anti-`init --force` guarantee.

function scaffoldSupporter(): string {
  const dir = mkdtempSync(join(tmpdir(), "fh-level-"));
  const answers: Answers = { ...BASE, level: "supporter", tierPricesCents: {} };
  writeFileSync(join(dir, "answers.json"), JSON.stringify(answers));
  const run = (...args: string[]): void => {
    execFileSync("npx", ["tsx", CLI, ...args], { cwd: dir, stdio: "ignore" });
  };
  run("keygen");
  run("init", "--answers", "answers.json");
  return dir;
}

function level(dir: string, ...args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("npx", ["tsx", CLI, "level", ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: (err.stdout ?? "") + (err.stderr ?? ""), code: err.status ?? -1 };
  }
}

test("`level` with no flags reports the level, the manifest's agreement, tiers and Stripe", () => {
  const dir = scaffoldSupporter();
  const { out, code } = level(dir);
  assert.equal(code, 0);
  assert.match(out, /PROVIDER_LEVEL\s+supporter/);
  assert.match(out, /signed manifest\s+supporter.*in sync/);
  assert.match(out, /tiers for sale\s+none/);
  assert.match(out, /Stripe\s+not configured — a Supporter needs no Stripe account/);
});

test("⭐ the upgrade changes two files and leaves every other byte alone", () => {
  const dir = scaffoldSupporter();
  const untouched = [".env.operator", join("data", "inventory.json"), "manifest-key.pem"];
  const before = untouched.map((f) => readFileSync(join(dir, f), "utf8"));
  const secretsBefore = readFileSync(join(dir, "secrets.env"), "utf8");
  const sessionSecret = /^SESSION_SECRET=(.*)$/m.exec(secretsBefore)?.[1];
  assert.ok(sessionSecret, "fixture should have a SESSION_SECRET to protect");

  const { out, code } = level(
    dir, "--set", "operator",
    "--price", "cumulus=25",
    "--stripe-key", "rk_test_x",
    "--stripe-webhook", "whsec_x",
    "--yes"
  );
  assert.equal(code, 0, out);

  const config = readFileSync(join(dir, "config.env"), "utf8");
  assert.match(config, /^PROVIDER_LEVEL=operator$/m);
  assert.match(config, /^TIER_PRICES_JSON=\{"cumulus":2500\}$/m);
  const secrets = readFileSync(join(dir, "secrets.env"), "utf8");
  assert.match(secrets, /^STRIPE_SECRET_KEY=rk_test_x$/m);
  assert.match(secrets, /^STRIPE_WEBHOOK_SECRET=whsec_x$/m);

  // The whole point: `init --force` would have rewritten all of these.
  untouched.forEach((f, i) => {
    assert.equal(readFileSync(join(dir, f), "utf8"), before[i], `${f} was modified`);
  });
  assert.match(secrets, new RegExp(`^SESSION_SECRET=${sessionSecret}$`, "m"), "SESSION_SECRET was reminted");
  assert.ok(readFileSync(join(dir, "config.env.bak"), "utf8").includes("PROVIDER_LEVEL=supporter"));
  assert.equal(readFileSync(join(dir, "secrets.env.bak"), "utf8"), secretsBefore);
});

test("⭐ the level is in the SIGNED manifest, so the upgrade goes stale until you re-sign", () => {
  const dir = scaffoldSupporter();
  level(dir, "--set", "operator", "--price", "cumulus=25", "--yes");
  const read = (f: string): string => readFileSync(join(dir, f), "utf8");

  const stale = runDoctor({ configEnv: read("config.env"), manifestJson: read("manifest.json") });
  assert.ok(
    stale.findings.some((f) => f.rule === "MANIFEST_STALE"),
    "a level change that did not re-sign must be reported"
  );

  execFileSync("npx", ["tsx", CLI, "sign"], { cwd: dir, stdio: "ignore" });
  const fresh = runDoctor({ configEnv: read("config.env"), manifestJson: read("manifest.json") });
  assert.equal(fresh.findings.filter((f) => f.rule === "MANIFEST_STALE").length, 0);
  assert.equal(renderManifestBodyFromConfig(read("config.env")).level, "operator");
  assert.equal(JSON.parse(read("manifest.json")).level, "operator");
});

test("a second identical upgrade changes nothing and exits 0", () => {
  const dir = scaffoldSupporter();
  level(dir, "--set", "operator", "--price", "cumulus=25", "--stripe-key", "rk_x", "--yes");
  const config = readFileSync(join(dir, "config.env"), "utf8");
  const { out, code } = level(dir, "--set", "operator", "--price", "cumulus=25", "--yes");
  assert.equal(code, 0);
  assert.match(out, /nothing to change/);
  assert.equal(readFileSync(join(dir, "config.env"), "utf8"), config);
});

test("⭐ a below-floor price is refused and NOTHING is written", () => {
  const dir = scaffoldSupporter();
  const before = readFileSync(join(dir, "config.env"), "utf8");
  const { out, code } = level(dir, "--set", "operator", "--price", "cumulus=1", "--yes");
  assert.equal(code, 1);
  assert.match(out, /below the \$7\.00 floor/);
  assert.match(out, /Nothing was written/);
  assert.equal(readFileSync(join(dir, "config.env"), "utf8"), before, "a rejected run must not half-apply");
});

test("--dry-run prints the same diff it would apply, and writes nothing", () => {
  const dir = scaffoldSupporter();
  const before = readFileSync(join(dir, "config.env"), "utf8");
  const dry = level(dir, "--set", "operator", "--price", "cumulus=25", "--dry-run");
  assert.equal(dry.code, 0);
  assert.match(dry.out, /PROVIDER_LEVEL: supporter → operator/);
  assert.match(dry.out, /nothing written/);
  assert.equal(readFileSync(join(dir, "config.env"), "utf8"), before);
});

test("the downgrade clears the prices, keeps Stripe, and says what it cannot see", () => {
  const dir = scaffoldSupporter();
  level(dir, "--set", "operator", "--price", "cumulus=25", "--stripe-key", "rk_x", "--stripe-webhook", "whsec_x", "--yes");
  const stripeLines = (): string[] =>
    readFileSync(join(dir, "secrets.env"), "utf8").split("\n").filter((l) => l.startsWith("STRIPE_"));
  const before = stripeLines();

  const { out, code } = level(dir, "--set", "supporter", "--yes");
  assert.equal(code, 0, out);
  const config = readFileSync(join(dir, "config.env"), "utf8");
  assert.match(config, /^PROVIDER_LEVEL=supporter$/m);
  assert.match(config, /^TIER_PRICES_JSON=\{\}$/m);
  assert.deepEqual(stripeLines(), before, "the webhook secret Stripe showed once must survive");
  assert.match(out, /cannot see your live rentals/);
});

test("⭐ doctor reports both halves of a level that disagrees with what is for sale", () => {
  const operatorNoTiers = runDoctor({
    configEnv: "PROVIDER_LEVEL=operator\nTIER_PRICES_JSON={}\n",
  });
  assert.ok(operatorNoTiers.findings.some((f) => f.rule === "LEVEL_OPERATOR_NO_TIERS"));

  const supporterWithPrices = runDoctor({
    configEnv: 'PROVIDER_LEVEL=supporter\nTIER_PRICES_JSON={"cumulus":2500}\n',
  });
  assert.ok(supporterWithPrices.findings.some((f) => f.rule === "LEVEL_SUPPORTER_WITH_PRICES"));

  // ...and neither fires when the two agree, in either direction.
  for (const configEnv of [
    'PROVIDER_LEVEL=operator\nTIER_PRICES_JSON={"cumulus":2500}\n',
    "PROVIDER_LEVEL=supporter\nTIER_PRICES_JSON={}\n",
  ]) {
    assert.equal(
      runDoctor({ configEnv }).findings.filter((f) => f.rule.startsWith("LEVEL_")).length,
      0,
      `a consistent config must not be flagged: ${configEnv}`
    );
  }
});
