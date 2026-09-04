import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SCHEMA_VERSION, joinSignedRecord, type LoanOffer, type LoanRequest } from "@moltentech/protocol";
import { generateEd25519 } from "@moltentech/protocol/signing";
import { loanStampRecord, signLoanRequest } from "@moltentech/protocol/loan-signing";
import { LOANED_CHIP, acceptsRestamp, parseCtime, readLoanState, type VmStamp } from "./loan-state";

const HEADER = "# flux-hub\nkind:     loaned\nborrower: moltentech-test1";

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

const BORROW = { vmName: "mt-187-c4", nodeName: "pve45", durationHours: 24 } as const;

const REQUEST: LoanRequest = {
  schemaVersion: SCHEMA_VERSION,
  revision: 1,
  borrowerSlug: "moltentech-test1",
  lenderSlug: "moltentech",
  offerRevision: 3,
  borrows: [{ ...BORROW }],
  issuedAt: "2026-09-04T12:00:00.000Z",
  nonce: "n-abc123",
};

/** 2026-09-04T12:00:00Z as the hypervisor records it. */
const CTIME = Math.floor(Date.UTC(2026, 8, 4, 12, 0, 0) / 1000);
const META = `creation-qemu=8.1.5,ctime=${CTIME}`;

function vm(over: Partial<VmStamp> = {}, req = REQUEST, key = borrower.privateKey): VmStamp {
  return {
    vmName: "mt-187-c4",
    nodeName: "pve45",
    tags: ["flux-hub", LOANED_CHIP, "cumulus"],
    description: joinSignedRecord(HEADER, loanStampRecord(signLoanRequest(req, key))),
    meta: META,
    ...over,
  };
}

const DURING = new Date(Date.UTC(2026, 8, 4, 20, 0, 0)); // 8h in
const AFTER = new Date(Date.UTC(2026, 8, 5, 13, 0, 0)); // 25h in — 1h past a 24h loan

// ── the happy path ────────────────────────────────────────────────────────────

test("a live loan reports its own clock, not the record's issuedAt", () => {
  const v = readLoanState(vm(), OFFER, DURING);
  assert.equal(v.loan, true);
  if (!v.loan) return;
  assert.equal(v.provisionedAt.toISOString(), "2026-09-04T12:00:00.000Z");
  assert.equal(v.expiresAt.toISOString(), "2026-09-05T12:00:00.000Z");
  assert.equal(v.expired, false);
});

test("past its window, the same loan reads as expired", () => {
  const v = readLoanState(vm(), OFFER, AFTER);
  assert.equal(v.loan, true);
  if (!v.loan) return;
  assert.equal(v.expired, true);
});

test("expiry takes min(request, offer ceiling) — a longer request cannot extend it", () => {
  // The request asks 48h; the offer only ever approved 12h.
  const req = { ...REQUEST, borrows: [{ ...BORROW, durationHours: 48 }] };
  const v = readLoanState(vm({}, req), { ...OFFER, maxDurationHours: 12 }, DURING);
  assert.equal(v.loan, true);
  if (!v.loan) return;
  assert.equal(v.expiresAt.toISOString(), "2026-09-05T00:00:00.000Z");
});

// ── the fences that could select the WRONG VM ─────────────────────────────────

test("a stamp naming ANOTHER VM never speaks for the one it sits on", () => {
  // The record is perfectly authentic. It is just not about this VM. Without this fence a copied
  // description would authorize deleting the VM it was pasted onto.
  const v = readLoanState(vm({ vmName: "mt-187-c9" }), OFFER, DURING);
  assert.deepEqual(v, { loan: false, reason: "stamp-names-another-vm" });
});

test("the same VM name on a different NODE is also another VM", () => {
  const req = { ...REQUEST, borrows: [{ ...BORROW, nodeName: "pve60" }] };
  const v = readLoanState(vm({ nodeName: "pve60" }, req), OFFER, DURING);
  assert.deepEqual(v, { loan: false, reason: "slot-not-offered" });
});

test("a slot this offer never put up is refused even when the signature is good", () => {
  const req = { ...REQUEST, borrows: [{ ...BORROW, vmName: "mt-187-c9" }] };
  const v = readLoanState(vm({ vmName: "mt-187-c9" }, req), OFFER, DURING);
  assert.deepEqual(v, { loan: false, reason: "slot-not-offered" });
});

test("no `loaned` chip means the description is never even consulted", () => {
  const v = readLoanState(vm({ tags: ["flux-hub", "paid", "cumulus"] }), OFFER, DURING);
  assert.deepEqual(v, { loan: false, reason: "not-loaned" });
});

test("a loaned chip with no stamp is 'no-record' — a chip alone authorizes nothing", () => {
  const v = readLoanState(vm({ description: HEADER }), OFFER, DURING);
  assert.deepEqual(v, { loan: false, reason: "no-record" });
});

test("another key's signature is refused", () => {
  const impostor = generateEd25519();
  const v = readLoanState(vm({}, REQUEST, impostor.privateKey), OFFER, DURING);
  assert.deepEqual(v, { loan: false, reason: "bad-signature" });
});

test("a record answering a different offer revision is refused", () => {
  const v = readLoanState(vm({}, { ...REQUEST, offerRevision: 2 }), OFFER, DURING);
  assert.deepEqual(v, { loan: false, reason: "unknown-offer-revision" });
});

test("a record naming a different lender is refused", () => {
  const req = { ...REQUEST, lenderSlug: "someone-else" };
  const v = readLoanState(vm({}, req), OFFER, DURING);
  assert.deepEqual(v, { loan: false, reason: "wrong-lender" });
});

test("a record naming a different borrower is refused", () => {
  const req = { ...REQUEST, borrowerSlug: "someone-else" };
  const v = readLoanState(vm({}, req), OFFER, DURING);
  assert.deepEqual(v, { loan: false, reason: "wrong-borrower" });
});

// ── the clock ─────────────────────────────────────────────────────────────────

test("no ctime means no clock, and no clock means no verdict", () => {
  const v = readLoanState(vm({ meta: "creation-qemu=8.1.5" }), OFFER, DURING);
  assert.deepEqual(v, { loan: false, reason: "no-ctime" });
  assert.deepEqual(readLoanState(vm({ meta: null }), OFFER, DURING), {
    loan: false,
    reason: "no-ctime",
  });
});

test("wildly overdue reads as BROKEN, not as overdue — the VM keeps running", () => {
  const v = readLoanState(vm(), OFFER, new Date(Date.UTC(2027, 0, 1)));
  assert.deepEqual(v, { loan: false, reason: "too-stale" });
});

test("just inside the stale window is still a real expiry", () => {
  const v = readLoanState(vm(), OFFER, AFTER, { maxOverdueMs: 2 * 60 * 60 * 1000 });
  assert.equal(v.loan, true);
  if (!v.loan) return;
  assert.equal(v.expired, true);
});

test("parseCtime reads seconds, rejects everything else", () => {
  assert.equal(parseCtime("creation-qemu=8.1.5,ctime=1708264093")?.toISOString(), "2024-02-18T13:48:13.000Z");
  assert.equal(parseCtime("ctime=1708264093")?.toISOString(), "2024-02-18T13:48:13.000Z");
  // The key is `ctime`, not `creation` — a substring match would find the wrong thing.
  assert.equal(parseCtime("creation-qemu=8.1.5"), null);
  assert.equal(parseCtime("myctime=123"), null);
  assert.equal(parseCtime("ctime=0"), null);
  assert.equal(parseCtime(""), null);
  assert.equal(parseCtime(null), null);
  assert.equal(parseCtime(undefined), null);
});

// ── monotonic re-stamp (§9d.3 rule 1) ─────────────────────────────────────────

test("a re-stamp of the same loan with a LATER expiry is accepted", () => {
  const signed = signLoanRequest(REQUEST, borrower.privateKey);
  const est = { request: signed, expiresAt: new Date("2026-09-05T12:00:00.000Z") };
  const later = { request: signed, expiresAt: new Date("2026-09-05T18:00:00.000Z") };
  assert.equal(acceptsRestamp(est, later), true);
  assert.equal(acceptsRestamp(est, est), true);
});

test("a re-stamp that pulls the expiry IN is refused — that is the rewind lever", () => {
  const signed = signLoanRequest(REQUEST, borrower.privateKey);
  const est = { request: signed, expiresAt: new Date("2026-09-05T12:00:00.000Z") };
  const earlier = { request: signed, expiresAt: new Date("2026-09-05T06:00:00.000Z") };
  assert.equal(acceptsRestamp(est, earlier), false);
});

test("a re-stamp of a DIFFERENT loan is refused however late its expiry", () => {
  const a = signLoanRequest(REQUEST, borrower.privateKey);
  // A genuinely different loan: same slot, borrowed again later. The nonce is content-derived,
  // so two records differing ONLY in a hand-set nonce are the same loan by construction.
  const b = signLoanRequest(
    { ...REQUEST, issuedAt: "2026-09-06T12:00:00.000Z" },
    borrower.privateKey
  );
  const est = { request: a, expiresAt: new Date("2026-09-05T12:00:00.000Z") };
  const other = { request: b, expiresAt: new Date("2026-09-09T12:00:00.000Z") };
  assert.equal(acceptsRestamp(est, other), false);
});
