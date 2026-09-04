import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SCHEMA_VERSION } from "./common";
import type { LoanOffer } from "./loan";
import { generateEd25519 } from "./signing";
import { signLoanOffer, verifyLoanStamp, loanStampRecord, signLoanRequest } from "./loan-signing";
import { joinSignedRecord } from "./signed-record";
import { acceptOffer } from "./loan-request";

const lender = generateEd25519();
const borrower = generateEd25519();

const OFFER: LoanOffer = {
  schemaVersion: SCHEMA_VERSION,
  revision: 3,
  lenderSlug: "moltentech",
  borrowerSlug: "moltentech-test1",
  borrowerPubkey: borrower.publicKeyBase64,
  slots: [{ vmName: "mt-187-c4", nodeName: "pve45", tier: "cumulus" }],
  maxDurationHours: 48,
  maxConcurrent: 1,
  offerExpiresAt: "2026-09-10T00:00:00.000Z",
  issuedAt: "2026-09-04T00:00:00.000Z",
  nonce: "offer-1",
};

const SIGNED = signLoanOffer(OFFER, lender.privateKey);
const ME = { slug: "moltentech-test1", pubkey: borrower.publicKeyBase64 };
const WANT = { vmName: "mt-187-c4", nodeName: "pve45", durationHours: 24 };
const AT = new Date("2026-09-04T12:00:00.000Z");

function accept(raw: unknown = SIGNED, pubkey = lender.publicKeyBase64, me = ME, want = WANT) {
  return acceptOffer(raw, pubkey, me, want, AT, AT);
}

test("a sound offer becomes a request bound to that offer's revision", () => {
  const v = accept();
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.request.offerRevision, 3);
  assert.equal(v.request.lenderSlug, "moltentech");
  assert.equal(v.request.borrowerSlug, "moltentech-test1");
  assert.deepEqual(v.request.borrows, [
    { vmName: "mt-187-c4", nodeName: "pve45", durationHours: 24 },
  ]);
});

test("a blob that is not an offer is refused before anything else", () => {
  assert.deepEqual(accept({ hello: "world" }), { ok: false, reason: "not-an-offer" });
});

test("the wrong lender key is refused — not silently accepted", () => {
  const stranger = generateEd25519();
  assert.deepEqual(accept(SIGNED, stranger.publicKeyBase64), {
    ok: false,
    reason: "bad-lender-signature",
  });
});

test("an offer altered in transit no longer verifies", () => {
  const tampered = { ...SIGNED, maxDurationHours: 72 };
  assert.deepEqual(accept(tampered), { ok: false, reason: "bad-lender-signature" });
});

test("an offer issued to someone else is refused", () => {
  assert.deepEqual(accept(SIGNED, lender.publicKeyBase64, { ...ME, slug: "someone-else" }), {
    ok: false,
    reason: "not-my-offer",
  });
});

test("⭐ an offer naming a DIFFERENT key for me is refused before signing", () => {
  // The sharpest check: the lender verifies the request against `offer.borrowerPubkey`, so
  // signing with any other key produces a request that fails on hardware the borrower cannot
  // see, logged only in the lender's agent. Catching it here makes it a local error.
  const other = generateEd25519();
  assert.deepEqual(accept(SIGNED, lender.publicKeyBase64, { ...ME, pubkey: other.publicKeyBase64 }), {
    ok: false,
    reason: "offer-names-another-key",
  });
});

test("an offer past its own window is refused", () => {
  const v = acceptOffer(SIGNED, lender.publicKeyBase64, ME, WANT, AT, new Date("2026-09-11"));
  assert.deepEqual(v, { ok: false, reason: "offer-window-closed" });
});

test("a slot the offer never put up is refused", () => {
  assert.deepEqual(accept(SIGNED, lender.publicKeyBase64, ME, { ...WANT, vmName: "mt-187-c9" }), {
    ok: false,
    reason: "slot-not-offered",
  });
});

test("the right vmName on the wrong node is a different slot", () => {
  assert.deepEqual(accept(SIGNED, lender.publicKeyBase64, ME, { ...WANT, nodeName: "pve60" }), {
    ok: false,
    reason: "slot-not-offered",
  });
});

test("too long is REFUSED, never clamped", () => {
  // A borrower who asked for 72h and silently got 48h would plan around a term nobody agreed to.
  assert.deepEqual(accept(SIGNED, lender.publicKeyBase64, ME, { ...WANT, durationHours: 72 }), {
    ok: false,
    reason: "duration-over-ceiling",
  });
});

test("exactly the ceiling is allowed", () => {
  const v = accept(SIGNED, lender.publicKeyBase64, ME, { ...WANT, durationHours: 48 });
  assert.equal(v.ok, true);
});

test("the platform's 72h cap binds even if a lender offered more", () => {
  // maxDurationHours is schema-capped at 72, so this is belt-and-braces — but the cap is a
  // platform rule and must not depend on the schema being the only thing that holds it.
  const long = signLoanOffer({ ...OFFER, maxDurationHours: 72 }, lender.privateKey);
  assert.deepEqual(accept(long, lender.publicKeyBase64, ME, { ...WANT, durationHours: 73 }), {
    ok: false,
    reason: "duration-over-ceiling",
  });
});

// ── the whole handshake, end to end ───────────────────────────────────────────

test("⭐ end to end: lender signs an offer, borrower answers it, the stamp verifies", () => {
  // This is the chain the lender's agent will walk on real hardware: offer -> request -> the
  // record stamped into the VM's description -> verified back off that description.
  const v = accept();
  assert.equal(v.ok, true);
  if (!v.ok) return;

  const signedRequest = signLoanRequest(v.request, borrower.privateKey);
  const description = joinSignedRecord("# flux-hub\nkind:     loaned", loanStampRecord(signedRequest));

  const readBack = verifyLoanStamp(description, OFFER.borrowerPubkey);
  assert.equal(readBack.ok, true);
  if (!readBack.ok) return;
  assert.equal(readBack.request.offerRevision, OFFER.revision);
  assert.equal(readBack.request.borrows[0]?.durationHours, 24);
});

test("the request is deterministic — the same acceptance signs to the same bytes", () => {
  const a = accept();
  const b = accept();
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(
    signLoanRequest(a.request, borrower.privateKey).signature,
    signLoanRequest(b.request, borrower.privateKey).signature
  );
});
