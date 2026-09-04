import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { InventoryHost, LoanOfferDeclaration } from "@moltentech/protocol";
import { generateEd25519 } from "@moltentech/protocol/signing";
import { loanOfferNonce, verifySignedLoanOffer } from "@moltentech/protocol/loan-signing";
import { buildLoanOffers, signLoanOffers } from "./loan-offer";

const borrower = generateEd25519();
const lender = generateEd25519();

const INVENTORY = [
  {
    name: "pve45",
    nodeName: "pve45",
    slots: [
      { tier: "cumulus", vmName: "mt-187-c4" },
      { tier: "nimbus", vmName: "mt-187-c5" },
    ],
  },
] as unknown as InventoryHost[];

const NOW = new Date("2026-09-04T12:00:00.000Z");

function decl(over: Partial<LoanOfferDeclaration> = {}): LoanOfferDeclaration {
  return {
    revision: 1,
    borrowerSlug: "moltentech-test1",
    borrowerPubkey: borrower.publicKeyBase64,
    vmName: "mt-187-c4",
    nodeName: "pve45",
    maxDurationHours: 24,
    offerExpiresAt: "2026-09-10T00:00:00.000Z",
    issuedAt: "2026-09-04T00:00:00.000Z",
    ...over,
  };
}

test("a sound declaration becomes an offer, with the tier taken from INVENTORY", () => {
  // The operator never types the tier, so an offer cannot advertise one that disagrees with the
  // slot's own declaration.
  const { offers, refused } = buildLoanOffers([decl()], INVENTORY, "moltentech", NOW);
  assert.deepEqual(refused, []);
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.lenderSlug, "moltentech");
  assert.deepEqual(offers[0]?.slots, [{ vmName: "mt-187-c4", nodeName: "pve45", tier: "cumulus" }]);
  assert.equal(offers[0]?.maxConcurrent, 1);
});

test("a slot not in inventory is refused — you cannot lend hardware you do not declare", () => {
  const { offers, refused } = buildLoanOffers(
    [decl({ vmName: "toms-nas" })],
    INVENTORY,
    "moltentech",
    NOW
  );
  assert.deepEqual(offers, []);
  assert.equal(refused[0]?.reason, "slot-not-in-inventory");
});

test("the same vmName on a DIFFERENT node is not in inventory either", () => {
  const { refused } = buildLoanOffers(
    [decl({ nodeName: "pve60" })],
    INVENTORY,
    "moltentech",
    NOW
  );
  assert.equal(refused[0]?.reason, "slot-not-in-inventory");
});

test("lending to yourself is refused", () => {
  const { refused } = buildLoanOffers(
    [decl({ borrowerSlug: "moltentech" })],
    INVENTORY,
    "moltentech",
    NOW
  );
  assert.equal(refused[0]?.reason, "self-borrow");
});

test("an offer whose window has already closed is refused, not signed", () => {
  const { refused } = buildLoanOffers(
    [decl({ offerExpiresAt: "2026-09-01T00:00:00.000Z" })],
    INVENTORY,
    "moltentech",
    NOW
  );
  assert.equal(refused[0]?.reason, "offer-expired");
});

test("two declarations sharing a (borrower, revision) — the second is refused as ambiguous", () => {
  // A request names its offer by revision (§7 step 3). Two offers sharing one would make
  // "which offer did this answer" resolvable only by iteration order.
  const { offers, refused } = buildLoanOffers(
    [decl(), decl({ vmName: "mt-187-c5" })],
    INVENTORY,
    "moltentech",
    NOW
  );
  assert.equal(offers.length, 1);
  assert.equal(refused[0]?.reason, "duplicate-revision");
});

test("the same revision for a DIFFERENT borrower is fine — revisions are per pair", () => {
  const { offers, refused } = buildLoanOffers(
    [decl(), decl({ borrowerSlug: "moltentech-test2", vmName: "mt-187-c5" })],
    INVENTORY,
    "moltentech",
    NOW
  );
  assert.deepEqual(refused, []);
  assert.equal(offers.length, 2);
});

test("a refused declaration does not burn its (borrower, revision) for a later good one", () => {
  const bad = decl({ vmName: "toms-nas" });
  const good = decl();
  const { offers, refused } = buildLoanOffers([bad, good], INVENTORY, "moltentech", NOW);
  assert.equal(refused.length, 1);
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.slots[0]?.vmName, "mt-187-c4");
});

test("maxConcurrent above the ceiling is refused even though the default path is fine", () => {
  const { refused } = buildLoanOffers(
    [decl({ maxConcurrent: 5 })],
    INVENTORY,
    "moltentech",
    NOW
  );
  assert.equal(refused[0]?.reason, "over-concurrency-ceiling");
});

test("one bad declaration never costs the operator the good ones", () => {
  const { offers, refused } = buildLoanOffers(
    [decl({ vmName: "toms-nas" }), decl({ revision: 2, vmName: "mt-187-c5" })],
    INVENTORY,
    "moltentech",
    NOW
  );
  assert.equal(offers.length, 1);
  assert.equal(refused.length, 1);
});

// ── the nonce is deterministic, which is the point ────────────────────────────

test("the same declaration yields a byte-identical offer on a different clock", () => {
  // Nothing in the offer is stamped at BUILD time — `issuedAt` comes from the declaration and
  // the nonce from the content — so two builds days apart agree exactly. (`now` still has to sit
  // inside the offer window; that is the one thing the clock legitimately decides.)
  const a = buildLoanOffers([decl()], INVENTORY, "moltentech", NOW).offers[0];
  const b = buildLoanOffers(
    [decl()],
    INVENTORY,
    "moltentech",
    new Date("2026-09-09T23:00:00.000Z")
  ).offers[0];
  assert.ok(a);
  assert.deepEqual(a, b);
});

test("a changed term changes the nonce", () => {
  const a = buildLoanOffers([decl()], INVENTORY, "moltentech", NOW).offers[0];
  const b = buildLoanOffers([decl({ maxDurationHours: 48 })], INVENTORY, "moltentech", NOW)
    .offers[0];
  assert.notEqual(a?.nonce, b?.nonce);
});

test("loanOfferNonce ignores any nonce already present", () => {
  const body = { a: 1, b: "x" };
  assert.equal(loanOfferNonce(body), loanOfferNonce({ ...body, nonce: "whatever" }));
});

// ── signing ───────────────────────────────────────────────────────────────────

test("a signed offer verifies against the LENDER's key", () => {
  const { offers } = buildLoanOffers([decl()], INVENTORY, "moltentech", NOW);
  const signed = signLoanOffers(offers, lender.privateKey);
  assert.equal(signed.length, 1);
  const v = verifySignedLoanOffer(signed[0], lender.publicKeyBase64);
  assert.equal(v.ok, true);
});

test("it does not verify against anyone else's key", () => {
  const { offers } = buildLoanOffers([decl()], INVENTORY, "moltentech", NOW);
  const signed = signLoanOffers(offers, lender.privateKey);
  assert.deepEqual(verifySignedLoanOffer(signed[0], borrower.publicKeyBase64), {
    ok: false,
    reason: "bad-signature",
  });
});

test("no key means no offers, never a crash", () => {
  // An operator on the legacy AGENT_KEY bearer has no manifest key. That must degrade to "you
  // cannot make offers yet", not take down provisioning for a feature they do not use.
  const { offers } = buildLoanOffers([decl()], INVENTORY, "moltentech", NOW);
  assert.deepEqual(signLoanOffers(offers, undefined), []);
});

test("signing is deterministic, so the operator's blob does not churn", () => {
  const { offers } = buildLoanOffers([decl()], INVENTORY, "moltentech", NOW);
  const a = signLoanOffers(offers, lender.privateKey)[0];
  const b = signLoanOffers(offers, lender.privateKey)[0];
  assert.equal(a?.signature, b?.signature);
});
