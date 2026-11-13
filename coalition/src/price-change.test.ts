/**
 * Coupon after-period price change (hub plan § Option H, 3c): the operator signs each change in
 * the console, and `POST /price` applies it only when BOTH the change and the coupon carry the
 * owner's signature and the amount is the one the coupon set.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  couponMessage,
  priceChangeMessage,
  AuthorizationList,
  HEADER_AGENT_SIGNATURE,
  HEADER_AGENT_TIMESTAMP,
  HEADER_AGENT_NONCE,
  HEADER_AGENT_SLUG,
  type CouponClaim,
  type PriceChangeClaim,
  type SignedCoupon,
} from "@moltentech/protocol";
import { signFluxMessage } from "@moltentech/protocol/wallet";
import { generateEd25519, signRequest, bodyHash } from "@moltentech/protocol/signing";
import { handlePriceChange, PriceChangeRefused } from "./price-change.js";
import {
  handleAgentPending,
  handleAgentAuthorizations,
  handleConsoleIndex,
  handleConsoleSignPrice,
  handleConsoleAuthorizePrice,
  handlePriceStatus,
  _resetPriceChangesForTest,
} from "./console.js";
import type { StripeLike } from "./stripe.js";
import type { CoalitionConfig } from "./config.js";

const OWNER_KEY = new Uint8Array(32).fill(0x22);
const OTHER_KEY = new Uint8Array(32).fill(0x33);
const OWNER = signFluxMessage(OWNER_KEY, "x").address;
const SLUG = "moltentech";

const coupon = (over: Partial<CouponClaim["coupon"]> = {}, top: Partial<CouponClaim> = {}): CouponClaim => ({
  providerSlug: SLUG,
  tier: "cumulus",
  recipient: null,
  token: "a".repeat(64),
  // Closed for new customers long ago: a price change still applies to a rental that redeemed it.
  expiresAt: "2020-01-01T00:00:00.000Z",
  coupon: { name: "HALFOFF90", discountPct: 50, termMonths: 3, afterPct: 0, maxUses: 100, oncePerCustomer: true, firstRentalOnly: false, ...over },
  ...top,
});
const signCoupon = (c: CouponClaim, key = OWNER_KEY): SignedCoupon => ({ claim: c, signature: signFluxMessage(key, couponMessage(c)).signature });

const change = (over: Partial<PriceChangeClaim> = {}): PriceChangeClaim => ({
  changeId: "pc_1",
  providerSlug: SLUG,
  rentalCode: "MT2-0012",
  stripeSubscriptionId: "sub_1",
  couponCode: "HALFOFF90",
  tier: "cumulus",
  fromCents: 500,
  toCents: 1000,
  firstChargeOn: "2027-02-13",
  ...over,
});
const signChange = (c: PriceChangeClaim, key = OWNER_KEY) => ({ claim: c, signature: signFluxMessage(key, priceChangeMessage(c)).signature });

const CFG = { providerSlug: SLUG, ownerAddress: OWNER, tierPrices: { cumulus: 1000 } };

function fakeStripe(sub: Record<string, any> = {}) {
  const updates: [string, Record<string, any>][] = [];
  const stripe = {
    prices: { list: async () => ({ data: [{ id: "price_tier", product: "prod_1" }] }) },
    subscriptions: {
      retrieve: async () => ({
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        metadata: { mtCoupon: "HALFOFF90", tier: "cumulus", rentalCode: "MT2-0012" },
        items: { data: [{ id: "si_1", price: { unit_amount: 500, product: "prod_1" } }] },
        ...sub,
      }),
      update: async (id: string, a: Record<string, any>) => (updates.push([id, a]), {}),
    },
  } as unknown as StripeLike;
  return { stripe, updates };
}
const req = (c = change(), cp = coupon()) => ({ schemaVersion: 1, providerSlug: SLUG, change: signChange(c), coupon: signCoupon(cp) }) as any;

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof PriceChangeRefused, `expected a refusal, got ${(e as Error).message}`);
    return (e as Error).message;
  }
  assert.fail("expected a refusal");
}

test("🔒 priceChangeMessage: the bytes the operator signs", () => {
  assert.equal(
    priceChangeMessage(change()),
    [
      "Flux Hub price change",
      "provider: moltentech",
      "rental: MT2-0012",
      "subscription: sub_1",
      "coupon: HALFOFF90",
      "tier: cumulus",
      "from: $5.00/month",
      "to: $10.00/month",
      "first charge: 2027-02-13",
      "id: pc_1",
    ].join("\n")
  );
});

test("then: full price → the item goes back on the tier's catalogue price, no proration", async () => {
  const { stripe, updates } = fakeStripe();
  const out = await handlePriceChange(stripe, CFG, req());
  assert.deepEqual(out, { schemaVersion: out.schemaVersion, ok: true, alreadyApplied: false, chargedCents: 1000 });
  assert.equal(updates.length, 1);
  const [id, a] = updates[0]!;
  assert.equal(id, "sub_1");
  assert.deepEqual(a.items, [{ id: "si_1", price: "price_tier" }]);
  assert.equal(a.proration_behavior, "none");
  assert.equal(a.metadata.mtPriceChange, "pc_1");
});

test("then: 20% off → an inline price on the same product", async () => {
  const { stripe, updates } = fakeStripe();
  await handlePriceChange(stripe, CFG, req(change({ toCents: 800 }), coupon({ afterPct: 20 })));
  assert.deepEqual(updates[0]![1].items, [
    { id: "si_1", price_data: { currency: "usd", product: "prod_1", unit_amount: 800, recurring: { interval: "month" } } },
  ]);
});

test("100 % coupon ($0 line) → full price", async () => {
  const { stripe, updates } = fakeStripe({ items: { data: [{ id: "si_1", price: { unit_amount: 0, product: "prod_1" } }] } });
  await handlePriceChange(stripe, CFG, req(change({ fromCents: 0 }), coupon({ discountPct: 100 })));
  assert.equal(updates.length, 1);
});

test("a retry after it applied: ok, nothing sent to Stripe", async () => {
  const { stripe, updates } = fakeStripe({ items: { data: [{ id: "si_1", price: { unit_amount: 1000, product: "prod_1" } }] } });
  const out = await handlePriceChange(stripe, CFG, req());
  assert.equal(out.alreadyApplied, true);
  assert.equal(updates.length, 0);
});

test("refusals: signatures, amount, coupon, subscription", async () => {
  const { stripe, updates } = fakeStripe();
  // The change signed by someone else.
  assert.match(await refused(handlePriceChange(stripe, CFG, { ...req(), change: signChange(change(), OTHER_KEY) })), /price change signature/);
  // The hub edits the signed amount.
  const s = signChange(change());
  assert.match(await refused(handlePriceChange(stripe, CFG, { ...req(), change: { ...s, claim: { ...s.claim, toCents: 2000 } } })), /price change signature/);
  // The coupon signed by someone else.
  assert.match(await refused(handlePriceChange(stripe, CFG, { ...req(), coupon: signCoupon(coupon(), OTHER_KEY) })), /coupon refused: .*signature/);
  // A signed amount the coupon does not set (operator signed $12 for a "then: full price" $10 tier).
  assert.match(await refused(handlePriceChange(stripe, CFG, req(change({ toCents: 1200 })))), /sets \$10\.00 after its period, the signed change says \$12\.00/);
  // "then: end the rental" and "always" have no after-price.
  assert.match(await refused(handlePriceChange(stripe, CFG, req(change(), coupon({ afterPct: -1 })))), /no price after its period/);
  assert.match(await refused(handlePriceChange(stripe, CFG, req(change(), coupon({ termMonths: null, afterPct: null })))), /no price after its period/);
  // A different coupon code than the change names.
  assert.match(await refused(handlePriceChange(stripe, CFG, req(change(), coupon({ name: "OTHER90" })))), /coupon sent is OTHER90/);
  // Another operator's change.
  assert.match(await refused(handlePriceChange(stripe, CFG, req(change({ providerSlug: "other" })))), /for other/);
  assert.match(await refused(handlePriceChange(stripe, { ...CFG, ownerAddress: undefined }, req())), /OWNER_ADDRESS/);
  assert.equal(updates.length, 0);

  const sub = async (over: Record<string, any>, c = change()) => refused(handlePriceChange(fakeStripe(over).stripe, CFG, req(c)));
  assert.match(await sub({ status: "canceled" }), /canceled/);
  assert.match(await sub({ metadata: { tier: "cumulus" } }), /did not start on coupon HALFOFF90/);
  assert.match(await sub({ metadata: { mtCoupon: "HALFOFF90", rentalCode: "MT2-0099" } }), /rental MT2-0099, not MT2-0012/);
  assert.match(await sub({ items: { data: [] } }), /0 items/);
  // Stale: the item no longer charges what the operator saw.
  assert.match(await sub({ items: { data: [{ id: "si_1", price: { unit_amount: 700, product: "prod_1" } }] } }), /charges \$7\.00, the signed change is from \$5\.00/);
});

// ── Console courier ──

const agent = generateEd25519();
function cfg(over: Partial<CoalitionConfig> = {}): CoalitionConfig {
  return {
    port: 8088,
    providerSlug: SLUG,
    mtBaseUrl: "https://mt.example",
    legacyBearersPresent: [],
    coalitionSigningKey: "k",
    mtPubkey: "p",
    stripeSecretKey: "sk_test",
    stripeWebhookSecret: "whsec",
    manifestPath: "./manifest.json",
    manifestJson: JSON.stringify({ providerSlug: SLUG, pubkey: agent.publicKeyBase64 }),
    ownerAddress: OWNER,
    sessionSecret: "secret",
    sessionTtlMs: 3600_000,
    tierPrices: { cumulus: 1000 },
    trialDays: 1,
    statsWindowDays: 30,
    fluxApiUrl: "https://api.runonflux.io",
    fluxPayments: false,
    ...over,
  } as CoalitionConfig;
}
function agentHeaders(method: string, path: string, body: Buffer) {
  const issuedAt = new Date().toISOString();
  const nonce = randomBytes(16).toString("hex");
  const signature = signRequest({ method, path, slug: SLUG, issuedAt, nonce, bodyHash: bodyHash(body) }, agent.privateKey);
  return { [HEADER_AGENT_SIGNATURE]: signature, [HEADER_AGENT_TIMESTAMP]: issuedAt, [HEADER_AGENT_NONCE]: nonce, [HEADER_AGENT_SLUG]: SLUG } as never;
}
function pushPending(priceChanges: unknown[] | undefined, c = cfg()) {
  const body = Buffer.from(JSON.stringify(priceChanges === undefined ? { items: [] } : { items: [], priceChanges }));
  return handleAgentPending(c, body, agentHeaders("POST", "/agent/pending", body));
}
const pollSigned = () => {
  const r = handleAgentAuthorizations(cfg(), Buffer.alloc(0), agentHeaders("GET", "/agent/authorizations", Buffer.alloc(0)));
  return AuthorizationList.parse(JSON.parse(r.body));
};

test("console: a pushed change is listed, signed in the wallet, and handed to the agent once", () => {
  _resetPriceChangesForTest();
  assert.equal(pushPending([change(), change({ changeId: "pc_other", providerSlug: "someone-else" })]).status, 200);
  const page = handleConsoleIndex(cfg()).body;
  assert.match(page, /Price changes awaiting your signature/);
  assert.match(page, /MT2-0012/);
  assert.match(page, /\$5\.00 → <b>\$10\.00<\/b>\/month/);
  assert.match(page, /sign-price\?changeId=pc_1/);
  assert.doesNotMatch(page, /pc_other/, "another operator's change is dropped");

  const sign = handleConsoleSignPrice(cfg(), new URLSearchParams({ changeId: "pc_1" }));
  assert.equal(sign.status, 200);
  assert.ok(sign.body.includes("Flux Hub price change"), "the launcher shows the exact message");

  // A wrong wallet is refused and the change stays pending.
  const bad = handleConsoleAuthorizePrice(cfg(), new URLSearchParams({ changeId: "pc_1", signature: signChange(change(), OTHER_KEY).signature }));
  assert.equal(bad.status, 401);
  assert.equal(pollSigned().priceChanges?.length, 0);

  const ok = handleConsoleAuthorizePrice(cfg(), new URLSearchParams({ changeId: "pc_1", signature: signChange(change()).signature }));
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(handlePriceStatus(new URLSearchParams({ changeId: "pc_1" })).body).status, "signed");
  const out = pollSigned();
  assert.equal(out.priceChanges?.length, 1);
  assert.equal(out.priceChanges![0]!.claim.changeId, "pc_1");
  assert.equal(pollSigned().priceChanges?.length, 0, "handed over once");
  // Signed twice: no longer pending.
  assert.equal(handleConsoleAuthorizePrice(cfg(), new URLSearchParams({ changeId: "pc_1", signature: signChange(change()).signature })).status, 409);
});

test("console: an older agent (no priceChanges) clears the list; no login gate = nothing listed or signable", () => {
  _resetPriceChangesForTest();
  pushPending([change()]);
  pushPending(undefined);
  assert.doesNotMatch(handleConsoleIndex(cfg()).body, /Price changes awaiting/);

  pushPending([change()], cfg({ sessionSecret: undefined }));
  const open = cfg({ sessionSecret: undefined });
  const page = handleConsoleIndex(open).body;
  assert.match(page, /Price changes awaiting your signature/);
  assert.doesNotMatch(page, /MT2-0012/, "a rental code never shows on an open console");
  assert.equal(handleConsoleSignPrice(open, new URLSearchParams({ changeId: "pc_1" })).status, 403);
  assert.equal(handleConsoleAuthorizePrice(open, new URLSearchParams({ changeId: "pc_1", signature: signChange(change()).signature })).status, 403);
});
