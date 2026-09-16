import { test } from "node:test";
import assert from "node:assert/strict";
import { renderManifestBodyFromConfig, parseConfigEnv } from "./manifest-config";
import { ProviderManifestBody } from "./manifest";
import {
  generateEd25519,
  publicKeyBase64FromPrivate,
  signManifestBody,
  verifyManifestObject,
} from "./signing";

const SAMPLE = `
# a comment
PROVIDER_SLUG=acme
PROVIDER_NAME=Acme Ops
PROVIDER_LOCATION=Berlin, DE
PROVIDER_CONTACT=ops@acme.example
COALITION_URL=https://acme.app.runonflux.io
HOSTS=pve20,pve40
TRIAL_DAYS=2
MANUAL_APPROVAL=true
SESSION_TTL_HOURS=24
`;

test("parseConfigEnv skips comments/blanks and keeps JSON values intact", () => {
  const env = parseConfigEnv(SAMPLE);
  assert.equal(env.PROVIDER_SLUG, "acme");
  assert.equal(env.HOSTS, "pve20,pve40");
  assert.equal(env["# a comment"], undefined);
});

test("renders a schema-valid manifest body from config.env", () => {
  const body = renderManifestBodyFromConfig(SAMPLE);
  // Optional fields present / absent per config.
  assert.deepEqual((body.provider as any), {
    slug: "acme",
    name: "Acme Ops",
    location: "Berlin, DE",
    contact: "ops@acme.example",
  });
  assert.equal(body.coalitionUrl, "https://acme.app.runonflux.io");
  assert.equal(body.trialDays, 2);
  assert.equal(body.manualApproval, true);
  // HOSTS becomes the owner-attested hardware list; no tiers/prices in the manifest.
  assert.deepEqual(body.hardware, [{ name: "pve20" }, { name: "pve40" }]);
  // The rendered body passes the real schema (with pubkey/publishedAt stamped as sign does).
  const stamped = { ...body, pubkey: "x", publishedAt: new Date().toISOString() };
  assert.equal(ProviderManifestBody.safeParse(stamped).success, true);
});

test("OWNER_ADDRESS maps to an optional ownerAddress (absent when unset)", () => {
  // Unset (the SAMPLE above) → bare body, no ownerAddress (backward compat).
  assert.equal(renderManifestBodyFromConfig(SAMPLE).ownerAddress, undefined);

  // Set → passed through verbatim, and the stamped body still validates.
  const withOwner = SAMPLE + "\nOWNER_ADDRESS=t1abcOwnerWalletAddress";
  const body = renderManifestBodyFromConfig(withOwner);
  assert.equal(body.ownerAddress, "t1abcOwnerWalletAddress");
  const stamped = { ...body, pubkey: "x", publishedAt: new Date().toISOString() };
  assert.equal(ProviderManifestBody.safeParse(stamped).success, true);
});

test("rendered body signs to a manifest the real verifier accepts", () => {
  const { privateKey } = generateEd25519();
  const body = renderManifestBodyFromConfig(SAMPLE);
  body.pubkey = publicKeyBase64FromPrivate(privateKey);
  body.publishedAt = new Date().toISOString();
  const manifest = { ...body, signature: signManifestBody(body, privateKey) };
  assert.equal(verifyManifestObject(manifest), true);
});

test("clear errors on malformed input", () => {
  assert.throws(() => renderManifestBodyFromConfig("PROVIDER_NAME=x"), /PROVIDER_SLUG is required/);
  assert.throws(
    () => renderManifestBodyFromConfig("PROVIDER_SLUG=a\nPROVIDER_NAME=b\nCOALITION_URL=u"),
    /HOSTS is required/
  );
  // An empty/comma-only HOSTS parses to zero names — caught, not silently unconstrained.
  assert.throws(
    () => renderManifestBodyFromConfig("PROVIDER_SLUG=a\nPROVIDER_NAME=b\nCOALITION_URL=u\nHOSTS=,"),
    /HOSTS must list/
  );
});

test("PROVIDER_VM_PREFIX maps to provider.vmNamePrefix (key absent when unset or empty)", () => {
  // Unset (SAMPLE) → the provider object has no such key, so an old config.env renders the
  // byte-identical body it always did.
  assert.equal("vmNamePrefix" in (renderManifestBodyFromConfig(SAMPLE).provider as object), false);
  assert.equal(
    "vmNamePrefix" in (renderManifestBodyFromConfig(SAMPLE + "\nPROVIDER_VM_PREFIX=").provider as object),
    false
  );
  const body = renderManifestBodyFromConfig(SAMPLE + "\nPROVIDER_VM_PREFIX=ac-");
  assert.equal((body.provider as { vmNamePrefix?: string }).vmNamePrefix, "ac-");
  const stamped = { ...body, pubkey: "x", publishedAt: new Date().toISOString() };
  assert.equal(ProviderManifestBody.safeParse(stamped).success, true);
  // A malformed prefix is passed through by the renderer and refused by the schema, the
  // way every other config.env value is: render is a mapping, the schema is the gate.
  const bad = renderManifestBodyFromConfig(SAMPLE + "\nPROVIDER_VM_PREFIX=mt");
  assert.equal(ProviderManifestBody.safeParse({ ...bad, pubkey: "x", publishedAt: new Date().toISOString() }).success, false);
});

test("facility keys map to serviceFlags; false/empty/absent leave the field OUT (legacy bytes unchanged)", () => {
  // The SAMPLE has none of the keys → none of the fields. A pre-facilities config.env must
  // still render the manifest it always did, or a re-sign changes bytes nobody asked for.
  const bare = renderManifestBodyFromConfig(SAMPLE).serviceFlags as Record<string, unknown>;
  assert.deepEqual(bare, { delegationAvailable: false, autoRenew: true, whiteLabel: false, languages: ["en"] });

  const withAll = SAMPLE + "\nISP_SPEED_MBPS=1000\nFIBER=true\nUPS=true\nGENERATOR=false\nDATA_CENTER=\n";
  const sf = renderManifestBodyFromConfig(withAll).serviceFlags as Record<string, unknown>;
  assert.equal(sf.ispSpeedMbps, 1000);
  assert.equal(sf.fiber, true);
  assert.equal(sf.ups, true);
  assert.equal("generator" in sf, false, "false is not declared, so it is not emitted");
  assert.equal("dataCenter" in sf, false, "empty is not declared");
  const stamped = { ...renderManifestBodyFromConfig(withAll), pubkey: "x", publishedAt: new Date().toISOString() };
  assert.equal(ProviderManifestBody.safeParse(stamped).success, true);
});

test("malformed facility values are refused with the key named", () => {
  assert.throws(() => renderManifestBodyFromConfig(SAMPLE + "\nISP_SPEED_MBPS=fast\n"), /ISP_SPEED_MBPS must be a positive whole number/);
  assert.throws(() => renderManifestBodyFromConfig(SAMPLE + "\nISP_SPEED_MBPS=0\n"), /ISP_SPEED_MBPS/);
  assert.throws(() => renderManifestBodyFromConfig(SAMPLE + "\nUPS=yes\n"), /UPS must be "true" or "false"/);
});
