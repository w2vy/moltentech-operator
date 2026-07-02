import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { base58check } from "@scure/base";
import { verifyFluxSignature, verifyOwnerAuth } from "./wallet";
import { ownerAuthMessage, type OwnerAuth, type OwnerAuthClaim } from "./messages";

// ── Independent signer ──────────────────────────────────────────────────────
// Deliberately reimplements the wire format from scratch (not importing wallet.ts)
// so the verifier is tested against a separate code path arriving at the same
// bytes — a real regression guard, not a tautology. Mirrors what a Flux wallet
// emits: dSHA256(varint-framed magic‖message), 65-byte compact recoverable sig,
// header byte = 27 + recid + (compressed ? 4 : 0), all base64.
const b58c = base58check(sha256);
const enc = new TextEncoder();
const dsha256 = (b: Uint8Array): Uint8Array => sha256(sha256(b));

function varint(n: number): Uint8Array {
  return n < 0xfd ? Uint8Array.from([n]) : Uint8Array.from([0xfd, n & 0xff, n >> 8]);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function magicHash(magic: string, message: string): Uint8Array {
  const m = enc.encode(magic);
  const g = enc.encode(message);
  return dsha256(concat(varint(m.length), m, varint(g.length), g));
}

// Deterministic private key (valid: 1 < k < n).
const PRIV = new Uint8Array(32).fill(0x11);
const MESSAGE = "move vmName=molten-nimbus-42 -> pve40 jobId=abc123";

function makeSig(
  magic: string,
  versionBytes: Uint8Array,
  compressed = true
): { address: string; sigB64: string } {
  const pub = secp256k1.getPublicKey(PRIV, compressed);
  const sig = secp256k1.sign(magicHash(magic, MESSAGE), PRIV);
  const header = 27 + sig.recovery + (compressed ? 4 : 0);
  const sigB64 = Buffer.from(
    concat(Uint8Array.from([header]), sig.toCompactRawBytes())
  ).toString("base64");
  const address = b58c.encode(concat(versionBytes, ripemd160(sha256(pub))));
  return { address, sigB64 };
}

const ZELCASH = "Zelcash Signed Message:\n";
const BITCOIN = "Bitcoin Signed Message:\n";
const V_T1 = Uint8Array.from([0x1c, 0xb8]); // Flux wallet (Zelcore) t1…
const V_BTC = Uint8Array.from([0x00]); // ZelID / SSP  1…

test("verifies a ZelID/SSP signature (Bitcoin magic, 0x00 P2PKH)", () => {
  const { address, sigB64 } = makeSig(BITCOIN, V_BTC);
  assert.equal(verifyFluxSignature(address, MESSAGE, sigB64), true);
});

test("verifies a Flux-wallet signature (Zelcash magic, t1)", () => {
  const { address, sigB64 } = makeSig(ZELCASH, V_T1);
  assert.equal(verifyFluxSignature(address, MESSAGE, sigB64), true);
});

test("verifies an uncompressed-key signature", () => {
  const { address, sigB64 } = makeSig(BITCOIN, V_BTC, false);
  assert.equal(verifyFluxSignature(address, MESSAGE, sigB64), true);
});

test("rejects a signature over a different message", () => {
  const { address, sigB64 } = makeSig(BITCOIN, V_BTC);
  assert.equal(verifyFluxSignature(address, "some other action", sigB64), false);
});

test("rejects a tampered signature byte", () => {
  const { address, sigB64 } = makeSig(BITCOIN, V_BTC);
  const buf = Buffer.from(sigB64, "base64");
  buf[10] = buf[10]! ^ 0xff;
  assert.equal(verifyFluxSignature(address, MESSAGE, buf.toString("base64")), false);
});

test("rejects a signature that recovers a different address", () => {
  const { sigB64 } = makeSig(BITCOIN, V_BTC);
  // A valid signature, but checked against someone else's address.
  const otherPub = secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), true);
  const otherAddr = b58c.encode(concat(V_BTC, ripemd160(sha256(otherPub))));
  assert.equal(verifyFluxSignature(otherAddr, MESSAGE, sigB64), false);
});

test("rejects malformed inputs", () => {
  assert.equal(verifyFluxSignature("not-an-address", MESSAGE, "AAAA"), false);
  const { address } = makeSig(BITCOIN, V_BTC);
  assert.equal(verifyFluxSignature(address, MESSAGE, "not-base64-65-bytes"), false);
});

// ── Owner authorization (Phase C) ───────────────────────────────────────────
// Sign a canonical owner-auth message with the same independent signer, as a Flux
// wallet would, and check the operator-side verifier accepts/rejects correctly.
function signOwnerAuth(claim: OwnerAuthClaim): { address: string; auth: OwnerAuth } {
  const pub = secp256k1.getPublicKey(PRIV, true);
  const sig = secp256k1.sign(magicHash(BITCOIN, ownerAuthMessage(claim)), PRIV);
  const header = 27 + sig.recovery + 4;
  const sigB64 = Buffer.from(
    concat(Uint8Array.from([header]), sig.toCompactRawBytes())
  ).toString("base64");
  const address = b58c.encode(concat(V_BTC, ripemd160(sha256(pub))));
  return { address, auth: { ...claim, signature: sigB64 } };
}

const CLAIM: OwnerAuthClaim = {
  action: "delete",
  providerSlug: "pve25-lab",
  vmName: "molten-nimbus-01",
  nodeName: "pve25",
  nonce: "nonce-abc123",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

test("verifyOwnerAuth accepts a valid, unexpired authorization", () => {
  const { address, auth } = signOwnerAuth(CLAIM);
  assert.deepEqual(verifyOwnerAuth(auth, address), { ok: true });
});

test("verifyOwnerAuth rejects an expired authorization", () => {
  const { address, auth } = signOwnerAuth({
    ...CLAIM,
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const r = verifyOwnerAuth(auth, address);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "authorization expired");
});

test("verifyOwnerAuth rejects a different pinned owner address", () => {
  const { auth } = signOwnerAuth(CLAIM);
  const otherPub = secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), true);
  const otherAddr = b58c.encode(concat(V_BTC, ripemd160(sha256(otherPub))));
  assert.equal(verifyOwnerAuth(auth, otherAddr).ok, false);
});

test("verifyOwnerAuth rejects a claim field tampered after signing", () => {
  const { address, auth } = signOwnerAuth(CLAIM);
  // Repoint the authorization at a different VM — the signature no longer matches.
  assert.equal(verifyOwnerAuth({ ...auth, vmName: "molten-nimbus-99" }, address).ok, false);
});

test("verifyOwnerAuth rejects a tampered signature", () => {
  const { address, auth } = signOwnerAuth(CLAIM);
  const buf = Buffer.from(auth.signature, "base64");
  buf[10] = buf[10]! ^ 0xff;
  assert.equal(verifyOwnerAuth({ ...auth, signature: buf.toString("base64") }, address).ok, false);
});

// External-wallet compatibility guard. The wire format was proven against a real
// Zelcore signature during the Phase-C spike, but those values were not saved. Drop
// a real Zelcore/ZelID signature here (or via env) to lock the format against a
// truly independent signer; skipped until populated.
const REAL = {
  address: process.env.FLUX_FIXTURE_ADDR ?? "",
  message: process.env.FLUX_FIXTURE_MSG ?? "",
  sigB64: process.env.FLUX_FIXTURE_SIG ?? "",
};
test("verifies a real Flux-wallet signature", { skip: !REAL.address }, () => {
  assert.equal(verifyFluxSignature(REAL.address, REAL.message, REAL.sigB64), true);
});
