import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SCHEMA_VERSION } from "./common";
import type { LoanRequest } from "./loan";
import { generateEd25519, publicKeyBase64FromPrivate } from "./signing";
import { joinSignedRecord } from "./signed-record";
import { loanStampRecord, signLoanRequest, verifyLoanStamp } from "./loan-signing";

const HEADER = "# flux-hub\nkind:     leased\nborrower: moltentech-test1";

const REQUEST: LoanRequest = {
  schemaVersion: SCHEMA_VERSION,
  revision: 1,
  borrowerSlug: "moltentech-test1",
  lenderSlug: "moltentech",
  offerRevision: 3,
  borrows: [{ vmName: "mt-187-c4", nodeName: "pve45", durationHours: 24 }],
  issuedAt: "2026-09-04T12:00:00.000Z",
  nonce: "n-abc123",
};

const borrower = generateEd25519();
const BORROWER_PUBKEY = borrower.publicKeyBase64;

function stamp(req = REQUEST, key = borrower.privateKey): string {
  return joinSignedRecord(HEADER, loanStampRecord(signLoanRequest(req, key)));
}

test("a stamp this borrower signed verifies, and yields the record back", () => {
  const v = verifyLoanStamp(stamp(), BORROWER_PUBKEY);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.request.borrows[0]?.vmName, "mt-187-c4");
  // The signer replaces whatever nonce came in with a content-derived one (§4.4).
  assert.match(v.request.nonce, /^[0-9a-f]{32}$/);
});

test("the pubkey comes from the OFFER — another key's signature does not verify", () => {
  // A record carrying its own key would prove only that its author owned a key.
  const other = generateEd25519();
  const v = verifyLoanStamp(stamp(REQUEST, other.privateKey), BORROWER_PUBKEY);
  assert.deepEqual(v, { ok: false, reason: "bad-signature" });
});

test("key order off the wire does not matter — the signature covers canonical bytes", () => {
  const signed = signLoanRequest(REQUEST, borrower.privateKey);
  // Re-serialise with keys in a deliberately different order.
  const reordered = JSON.stringify(
    Object.fromEntries(Object.entries(signed).reverse())
  );
  const v = verifyLoanStamp(joinSignedRecord(HEADER, reordered), BORROWER_PUBKEY);
  assert.equal(v.ok, true);
});

test("a trailing newline on the record does not break verification", () => {
  // The whole reason splitSignedRecord owns the normalisation: a signer emitting `json + "\n"`
  // verifies locally and fails only after a Proxmox round trip.
  const signed = loanStampRecord(signLoanRequest(REQUEST, borrower.privateKey));
  const v = verifyLoanStamp(`${HEADER}\n--- signed ---\n${signed}\n\n`, BORROWER_PUBKEY);
  assert.equal(v.ok, true);
});

test("one flipped byte in the payload fails, and fails as bad-signature not schema", () => {
  const tampered = stamp().replace('"durationHours":24', '"durationHours":72');
  assert.deepEqual(verifyLoanStamp(tampered, BORROWER_PUBKEY), {
    ok: false,
    reason: "bad-signature",
  });
});

test("a header with no signed section is 'no-record', not an error", () => {
  assert.deepEqual(verifyLoanStamp(HEADER, BORROWER_PUBKEY), { ok: false, reason: "no-record" });
});

test("junk under the delimiter is 'not-json'", () => {
  assert.deepEqual(verifyLoanStamp(joinSignedRecord(HEADER, "not json at all"), BORROWER_PUBKEY), {
    ok: false,
    reason: "not-json",
  });
});

test("a JSON array under the delimiter is 'not-json', never a record", () => {
  assert.deepEqual(verifyLoanStamp(joinSignedRecord(HEADER, "[1,2,3]"), BORROWER_PUBKEY), {
    ok: false,
    reason: "not-json",
  });
});

test("v1 refuses any revision but the first (single-shot, §0.2 item 3)", () => {
  const r = { ...REQUEST, revision: 2 } as unknown as LoanRequest;
  assert.deepEqual(verifyLoanStamp(stamp(r), BORROWER_PUBKEY), { ok: false, reason: "schema" });
});

test("v1 refuses a multi-slot request", () => {
  const r = {
    ...REQUEST,
    borrows: [
      { vmName: "mt-187-c4", nodeName: "pve45", durationHours: 24 },
      { vmName: "mt-187-c5", nodeName: "pve45", durationHours: 24 },
    ],
  } as unknown as LoanRequest;
  assert.deepEqual(verifyLoanStamp(stamp(r), BORROWER_PUBKEY), { ok: false, reason: "schema" });
});

test("a duration past the 72h cap is refused by the schema, never clamped", () => {
  const r = {
    ...REQUEST,
    borrows: [{ vmName: "mt-187-c4", nodeName: "pve45", durationHours: 96 }],
  } as unknown as LoanRequest;
  assert.deepEqual(verifyLoanStamp(stamp(r), BORROWER_PUBKEY), { ok: false, reason: "schema" });
});

test("the nonce is derived from content, so two signings agree byte for byte", () => {
  const a = signLoanRequest(REQUEST, borrower.privateKey);
  const b = signLoanRequest({ ...REQUEST, nonce: "something-else" }, borrower.privateKey);
  assert.equal(a.nonce, b.nonce);
  assert.equal(a.signature, b.signature);
});

test("a changed TERM changes the nonce", () => {
  const a = signLoanRequest(REQUEST, borrower.privateKey);
  const b = signLoanRequest(
    { ...REQUEST, borrows: [{ vmName: "mt-187-c4", nodeName: "pve45", durationHours: 48 }] },
    borrower.privateKey
  );
  assert.notEqual(a.nonce, b.nonce);
});

test("the signature is over the record WITHOUT its own signature key", () => {
  const signed = signLoanRequest(REQUEST, borrower.privateKey);
  const { signature, ...body } = signed;
  assert.ok(signature.length > 0);
  assert.equal("signature" in body, false);
  // Re-signing the same body reproduces the same detached signature (ed25519 is deterministic).
  assert.equal(signLoanRequest(REQUEST, borrower.privateKey).signature, signature);
});

test("publicKeyBase64FromPrivate agrees with the generated public half", () => {
  assert.equal(publicKeyBase64FromPrivate(borrower.privateKey), BORROWER_PUBKEY);
});
