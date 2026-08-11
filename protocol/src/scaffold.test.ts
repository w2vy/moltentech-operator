import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateAll,
  validateAnswers,
  coalitionUrlFor,
  suggestFluxAppName,
  resolvedPrices,
  hasPaidTier,
  renderSecretsEnv,
  type Answers,
} from "./scaffold";
import { renderManifestBodyFromConfig, parseConfigEnv } from "./manifest-config";
import { runDoctor } from "./config-lint";
import { generateEd25519, signManifestBody, verifyManifestObject, publicKeyBase64FromPrivate } from "./signing";
import { ProviderManifest } from "./manifest";

/** Modelled on moltentech-test1, the known-good output of a real onboarding. */
const ANSWERS: Answers = {
  providerSlug: "acme-nodes",
  providerName: "Acme Nodes",
  providerLocation: "Florida, US",
  providerContact: "ops@acme.example",
  ownerAddress: "16XwByfoPsfgSVzoE94iD39o8sPw2sJXT4",
  mtBaseUrl: "https://staging.moltentech.us",
  fluxAppName: "coalition-acme-nodes",
  hosts: [
    {
      name: "pve30",
      storageImages: "ssd",
      storageIso: "pve55-shared",
      slots: [
        {
          tier: "cumulus",
          vmName: "mt-187-c2",
          ipAddress: "47.206.56.187",
          lanIp: "192.168.87.2/24",
          gateway: "192.168.87.1",
          apiPort: 16127,
        },
      ],
    },
  ],
};

test("the generated config.env renders a manifest body AND signs+verifies", () => {
  // §9's non-negotiable: "a generated config.env that cannot be signed is the failure
  // this must never ship with." Runs the real signer, not a stub.
  const files = generateAll(ANSWERS);
  const body = renderManifestBodyFromConfig(files["config.env"]);

  // Mirror `sign` exactly: pubkey + publishedAt are stamped onto the body BEFORE
  // signing, so they are inside the signed bytes. Signing first and adding them
  // afterwards produces a manifest that fails verification.
  const { privateKey } = generateEd25519();
  body.pubkey = publicKeyBase64FromPrivate(privateKey);
  body.publishedAt = new Date().toISOString();
  const signature = signManifestBody(body, privateKey);
  const manifest = { ...body, signature };

  assert.equal(verifyManifestObject(manifest), true);
  // And it is a well-formed manifest by the protocol's own schema, not just verifiable.
  assert.doesNotThrow(() => ProviderManifest.parse(manifest));
});

test("the manifest body carries the answers through unchanged", () => {
  const body = renderManifestBodyFromConfig(generateAll(ANSWERS)["config.env"]) as Record<string, any>;
  assert.equal(body.provider.slug, "acme-nodes");
  assert.equal(body.ownerAddress, ANSWERS.ownerAddress);
  assert.equal(body.coalitionUrl, "https://coalition-acme-nodes.app.runonflux.io");
  assert.deepEqual(body.hardware, [{ name: "pve30" }]);
});

test("everything generated passes doctor — the generator cannot emit its own findings", () => {
  const files = generateAll(ANSWERS);
  const report = runDoctor({
    configEnv: files["config.env"],
    secretsEnv: files["secrets.env"],
    envOperator: files[".env.operator"],
    inventoryJson: files["inventory.json"],
  });
  // A fresh scaffold must produce ZERO errors: every empty slot is NOT_YET_FILLED,
  // a warning that names the step issuing the value. If `init` output made `doctor`
  // print an error, the wizard's own first run would look like a fault.
  const errors = report.findings.filter((f) => f.severity === "error");
  assert.deepEqual(errors, []);
  assert.ok(
    report.findings.every((f) => f.rule === "NOT_YET_FILLED"),
    `unexpected rules: ${report.findings.map((f) => f.rule).join(", ")}`
  );
});

test("COALITION_URL is derived identically into both files that carry it", () => {
  const files = generateAll(ANSWERS);
  const cfg = parseConfigEnv(files["config.env"]);
  const op = parseConfigEnv(files[".env.operator"]);
  assert.equal(cfg.COALITION_URL, op.COALITION_URL);
  assert.equal(cfg.COALITION_URL, coalitionUrlFor(ANSWERS.fluxAppName));
  // The whole ENV_DUPLICATED_ACROSS_FILES class, structurally impossible.
  for (const k of ["PROVIDER_SLUG", "MT_BASE_URL", "OWNER_ADDRESS"]) {
    assert.equal(cfg[k], op[k], `${k} must match across files`);
  }
});

test("HOSTS and inventory host names come from one answer, so the 409 cannot happen", () => {
  const files = generateAll(ANSWERS);
  const cfg = parseConfigEnv(files["config.env"]);
  const inv = JSON.parse(files["inventory.json"]) as Array<{ name: string }>;
  assert.deepEqual(
    cfg.HOSTS!.split(","),
    inv.map((h) => h.name)
  );
});

test("inventory.json is a top-level array, matching the live known-good file", () => {
  assert.ok(Array.isArray(JSON.parse(generateAll(ANSWERS)["inventory.json"])));
});

test("prices default to the platform floor for every tier in use", () => {
  assert.deepEqual(resolvedPrices(ANSWERS), { cumulus: 700 });
});

test("an explicit price above the floor is kept", () => {
  const prices = resolvedPrices({ ...ANSWERS, tierPricesCents: { cumulus: 1200 } });
  assert.deepEqual(prices, { cumulus: 1200 });
});

test("suggestFluxAppName folds the slug in, so one choice validates the other", () => {
  assert.equal(suggestFluxAppName("acme-nodes"), "coalition-acme-nodes");
});

test("validateAnswers rejects a lanIp with no CIDR — the silent /32", () => {
  const bad = structuredClone(ANSWERS);
  bad.hosts[0]!.slots[0]!.lanIp = "192.168.87.2";
  assert.match(validateAnswers(bad).join("\n"), /\/NN/);
});

test("validateAnswers rejects a malformed slug and says it is permanent", () => {
  assert.match(validateAnswers({ ...ANSWERS, providerSlug: "Acme_Nodes" }).join("\n"), /PERMANENT/);
});

test("validateAnswers rejects a price below the floor", () => {
  assert.match(
    validateAnswers({ ...ANSWERS, tierPricesCents: { cumulus: 100 } }).join("\n"),
    /below the platform floor/
  );
});

test("validateAnswers rejects duplicate vmNames", () => {
  const dup = structuredClone(ANSWERS);
  dup.hosts[0]!.slots.push({ ...dup.hosts[0]!.slots[0]! });
  assert.match(validateAnswers(dup).join("\n"), /duplicate vmName/);
});

test("valid answers produce no complaints", () => {
  assert.deepEqual(validateAnswers(ANSWERS), []);
});

test("a self-hoster's scaffold omits Stripe entirely", () => {
  // The self-hoster with no customers should never see a Stripe prompt (NO_STRIPE).
  const free = renderSecretsEnv({ ...ANSWERS }, { includeStripe: false });
  assert.ok(!free.includes("STRIPE_SECRET_KEY"));
  assert.match(free, /not listing anything for sale/);
});

test("selling:false writes an EMPTY price list, not a zero price", () => {
  // A tier priced at 0 cannot be listed — MT 422s anything below the floor — so the
  // only way to sell nothing is to list nothing.
  const files = generateAll({ ...ANSWERS, selling: false });
  assert.match(files["config.env"], /^TIER_PRICES_JSON=\{\}$/m);
  assert.ok(!files["secrets.env"].includes("STRIPE_SECRET_KEY"));
});

test("selling (the default) prices every tier in use at the floor", () => {
  assert.match(generateAll(ANSWERS)["config.env"], /^TIER_PRICES_JSON=\{"cumulus":700\}$/m);
});

test("a paid listing includes Stripe AND warns that whsec is endpoint-bound", () => {
  const paid = renderSecretsEnv(ANSWERS, { includeStripe: true });
  assert.ok(paid.includes("STRIPE_WEBHOOK_SECRET="));
  assert.match(paid, /bound to THAT endpoint/);
});

test("hasPaidTier: anything listed is paid, because every price clears the floor", () => {
  assert.equal(hasPaidTier({}), false);
  assert.equal(hasPaidTier({ cumulus: 700 }), true);
});

test("every secrets.env comment is on its own line — a trailing one poisons the value", () => {
  for (const line of renderSecretsEnv(ANSWERS, { includeStripe: true }).split("\n")) {
    if (line.includes("=") && !line.trim().startsWith("#")) {
      const value = line.slice(line.indexOf("=") + 1);
      assert.ok(!value.includes("#"), `trailing comment leaked into a value: ${line}`);
    }
  }
});

test("secrets.env ships every value EMPTY — init cannot know them yet", () => {
  for (const line of renderSecretsEnv(ANSWERS, { includeStripe: true }).split("\n")) {
    if (line.includes("=") && !line.trim().startsWith("#")) {
      assert.match(line, /=$/, `expected an empty slot: ${line}`);
    }
  }
});

test("every key the live agent env carries is generated — no silent gap", () => {
  // Derived from the real ~/mt-agents/test1/.env.operator. Three of these (network,
  // storage import, ISO name) have agent-side defaults, which is exactly why their
  // absence is dangerous: PROXMOX_NETWORK defaults to vmbr0, and a VM on the wrong
  // bridge boots fine and is reachable by nobody.
  const text = generateAll(ANSWERS)[".env.operator"];
  for (const key of [
    "PROVIDER_SLUG",
    "MT_BASE_URL",
    "OWNER_ADDRESS",
    "COALITION_URL",
    "MANIFEST_KEY",
    "PROXMOX_URL",
    "PROXMOX_TOKEN_ID",
    "PROXMOX_TOKEN_SECRET",
    "PROXMOX_NETWORK",
    "PROXMOX_STORAGE_IMAGES",
    "PROXMOX_STORAGE_ISO",
    "PROXMOX_STORAGE_IMPORT",
    "ARCANE_ISO",
    "AGENT_INVENTORY_PATH",
    "AGENT_LISTING_JSON",
    "AGENT_DRY_RUN",
  ]) {
    assert.match(text, new RegExp(`^${key}=`, "m"), `.env.operator is missing ${key}`);
  }
});

test("an explicit bridge overrides the vmbr0 default", () => {
  const vlan = structuredClone(ANSWERS);
  vlan.hosts[0]!.network = "vmbr187";
  assert.match(generateAll(vlan)[".env.operator"], /^PROXMOX_NETWORK=vmbr187$/m);
});
