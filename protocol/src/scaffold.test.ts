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
  fillManifestPubkey,
  slotCountsByTier,
  resolvedListing,
  COALITION_IMAGE,
  type Answers,
} from "./scaffold";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
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

test("validateAnswers rejects a price below the minimum", () => {
  assert.match(
    validateAnswers({ ...ANSWERS, tierPricesCents: { cumulus: 100 } }).join("\n"),
    /below the platform minimum/
  );
});

test("validateAnswers honours LIVE minimums over the bundled table", () => {
  // If MT lowers a minimum, the wizard must accept the new price without anyone
  // editing this repo — that is the entire point of GET /api/tiers.
  assert.deepEqual(validateAnswers({ ...ANSWERS, tierPricesCents: { cumulus: 400 } }, { cumulus: 400 }), []);
  assert.match(
    validateAnswers({ ...ANSWERS, tierPricesCents: { cumulus: 400 } }).join("\n"),
    /below the platform minimum/
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
  // A tier priced at 0 cannot be listed — MT 422s anything below minPriceCents — so
  // the only way to sell nothing is to list nothing. (An admin-assigned "free rental"
  // is a different thing entirely and needs no listing at all.)
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

test("every generated slot carries its own network AND storagePool", () => {
  // The defect this closes: both values were written at HOST level only, MT's ingest
  // reads them PER SLOT, so every Slot row landed with empty `storagePool` and
  // `network` — and nothing caught it, because `doctor` checks the host-level value
  // that WAS written. Assert on the slot, not the host.
  const inv = JSON.parse(generateAll(ANSWERS)["inventory.json"]) as Array<{
    network?: string;
    slots: Array<{ network?: string; storagePool?: string }>;
  }>;
  for (const host of inv) {
    for (const slot of host.slots) {
      assert.ok(slot.storagePool, "slot has no storagePool — the Slot row will be empty");
      assert.ok(slot.network, "slot has no network — the Slot row will be empty");
    }
  }
  assert.equal(inv[0]!.slots[0]!.storagePool, "ssd");
  assert.equal(inv[0]!.slots[0]!.network, "vmbr0");
});

test("a slot inherits the host's bridge and storage, and can override both", () => {
  // Per-slot precedence must match what the agent actually provisions with
  // (`slot.storagePool ?? host.storageImages`, `slot.network ?? host.network`), or
  // inventory describes a machine the provision does not build.
  const mixed = structuredClone(ANSWERS);
  mixed.hosts[0]!.network = "vmbr187";
  mixed.hosts[0]!.slots.push({
    ...mixed.hosts[0]!.slots[0]!,
    vmName: "mt-187-c3",
    network: "vmbr102",
    storagePool: "nvme",
  });
  const [host] = JSON.parse(generateAll(mixed)["inventory.json"]) as Array<{
    network?: string;
    slots: Array<{ network?: string; storagePool?: string }>;
  }>;
  assert.equal(host!.network, "vmbr187");
  assert.deepEqual(
    host!.slots.map((s) => [s.network, s.storagePool]),
    [
      ["vmbr187", "ssd"],
      ["vmbr102", "nvme"],
    ]
  );
});

test(".env.operator always carries a MANIFEST_PUBKEY slot, empty until keygen", () => {
  // Empty-but-present, the same rule the other not-yet-issued values follow: an absent
  // line is invisible, and its absence is why `mt-agent doctor`'s key check could only
  // ever report `skip`.
  assert.match(generateAll(ANSWERS)[".env.operator"], /^MANIFEST_PUBKEY=$/m);
  assert.match(generateAll(ANSWERS, { manifestPubkey: "PUB" })[".env.operator"], /^MANIFEST_PUBKEY=PUB$/m);
});

test("fillManifestPubkey fills an empty slot and leaves a pinned one alone", () => {
  const fresh = generateAll(ANSWERS)[".env.operator"];
  const filled = fillManifestPubkey(fresh, "NEWPUB");
  assert.equal(filled.result, "filled");
  assert.match(filled.text, /^MANIFEST_PUBKEY=NEWPUB$/m);

  // Rotating over an existing pin would erase the mismatch `mt-agent doctor` exists to
  // report, so a non-empty value is never rewritten.
  const again = fillManifestPubkey(filled.text, "OTHERPUB");
  assert.equal(again.result, "already-set");
  assert.equal(again.text, filled.text);
});

test("fillManifestPubkey appends a slot to a file written by an older init", () => {
  const legacy = "PROVIDER_SLUG=acme-nodes\nMANIFEST_KEY=\n";
  const { text, result } = fillManifestPubkey(legacy, "PUB");
  assert.equal(result, "filled");
  assert.match(text, /^MANIFEST_PUBKEY=PUB$/m);
  assert.match(text, /^PROVIDER_SLUG=acme-nodes$/m, "existing keys must survive untouched");
  // parseConfigEnv is what every consumer uses; the appended block must parse.
  assert.equal(parseConfigEnv(text).MANIFEST_PUBKEY, "PUB");
});

test("the generated Flux app spec pins the Coalition image, and pins what the doc pins", () => {
  // `:latest` deploys fine today and breaks reproducibility invisibly — a Flux app spec
  // is a signed artifact, so two operators registering "the same" spec weeks apart get
  // different code with nothing recording that they differ.
  const spec = JSON.parse(generateAll(ANSWERS)["flux-app-spec.json"]) as {
    compose: Array<{ repotag: string }>;
  };
  assert.equal(spec.compose[0]!.repotag, COALITION_IMAGE);
  assert.doesNotMatch(COALITION_IMAGE, /:latest$/, "the generated spec must not deploy :latest");
  assert.match(COALITION_IMAGE, /^w2vy\/coalition:\d+\.\d+\.\d+$/);

  // The doc and the generator pin the SAME version, or an operator following the doc
  // and an operator running `init` deploy different code from the same instructions.
  const doc = fileURLToPath(new URL("../../docs/operator-onboarding.md", import.meta.url));
  if (!existsSync(doc)) return; // running from a context without the repo docs
  const pins = [...new Set(readFileSync(doc, "utf8").match(/w2vy\/coalition:[^\s`)]+/g) ?? [])];
  assert.deepEqual(pins, [COALITION_IMAGE], "docs/operator-onboarding.md pins a different image");
});

test("AGENT_LISTING_JSON is an ARRAY the agent can parse, not the price map", () => {
  // The defect: `init` wrote TIER_PRICES_JSON's map here verbatim, so every operator's
  // agent died at startup with `ZodError: Expected array, received object`. Parse it
  // with the agent's own schema shape rather than eyeballing the JSON.
  const value = parseConfigEnv(generateAll(ANSWERS)[".env.operator"]).AGENT_LISTING_JSON!;
  const listing = JSON.parse(value);
  assert.ok(Array.isArray(listing), `AGENT_LISTING_JSON is not an array: ${value}`);
  assert.deepEqual(listing, [{ tier: "cumulus", priceCents: 700, availableSlots: 1 }]);

  const ListingTierConfig = z.object({
    tier: z.string(),
    priceCents: z.number().int().positive(),
    availableSlots: z.number().int().nonnegative(),
  });
  assert.doesNotThrow(() => z.array(ListingTierConfig).parse(listing));
});

test("availableSlots defaults to every slot of that tier, across hosts", () => {
  const two = structuredClone(ANSWERS);
  two.hosts[0]!.slots.push({ ...two.hosts[0]!.slots[0]!, vmName: "mt-187-c3" });
  two.hosts.push({
    name: "pve40",
    storageImages: "ssd",
    storageIso: "pve55-shared",
    slots: [{ ...two.hosts[0]!.slots[0]!, tier: "nimbus", vmName: "mt-187-n1" }],
  });
  assert.deepEqual(slotCountsByTier(two), { cumulus: 2, nimbus: 1 });
  assert.deepEqual(resolvedListing(two), [
    { tier: "cumulus", priceCents: 700, availableSlots: 2 },
    { tier: "nimbus", priceCents: 2000, availableSlots: 1 },
  ]);
});

test("an operator can hold slots back by offering fewer than they declared", () => {
  const held = structuredClone(ANSWERS);
  held.hosts[0]!.slots.push({ ...held.hosts[0]!.slots[0]!, vmName: "mt-187-c3" });
  held.availableSlots = { cumulus: 1 };
  assert.deepEqual(resolvedListing(held), [{ tier: "cumulus", priceCents: 700, availableSlots: 1 }]);
  assert.deepEqual(validateAnswers(held), []);
});

test("offering MORE than you declared is rejected, even though MT would clamp it", () => {
  // MT clamps to the live available count so this cannot oversell — but the number
  // means the operator believes they declared hardware they did not.
  const over = structuredClone(ANSWERS);
  over.availableSlots = { cumulus: 5 };
  assert.match(validateAnswers(over).join("\n"), /more than the 1 cumulus slot/);

  const unknown = structuredClone(ANSWERS);
  unknown.availableSlots = { stratus: 1 };
  assert.match(validateAnswers(unknown).join("\n"), /which no slot uses/);
});

test("a self-hoster lists nothing at all — an empty array, not a zero-priced tier", () => {
  const value = parseConfigEnv(generateAll({ ...ANSWERS, selling: false })[".env.operator"])
    .AGENT_LISTING_JSON!;
  assert.deepEqual(JSON.parse(value), []);
});

test("the listing price and TIER_PRICES_JSON cannot disagree", () => {
  // Two files, one answer: if these ever diverge the Coalition and MT quote different
  // numbers for the same tier.
  const files = generateAll({ ...ANSWERS, tierPricesCents: { cumulus: 1200 } });
  const prices = JSON.parse(parseConfigEnv(files["config.env"]).TIER_PRICES_JSON!);
  for (const entry of JSON.parse(parseConfigEnv(files[".env.operator"]).AGENT_LISTING_JSON!)) {
    assert.equal(entry.priceCents, prices[entry.tier], `price for ${entry.tier} disagrees across files`);
  }
});
