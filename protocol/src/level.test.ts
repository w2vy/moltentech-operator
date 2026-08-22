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
