import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { base58check } from "@scure/base";
import {
  ProviderManifest,
  SignedProviderManifest,
  manifestOwnerMessage,
  unwrapManifest,
  type ProviderManifest as ProviderManifestT,
} from "./manifest";
import { verifyManifestOwnerSignature } from "./wallet";
import { generateEd25519, signManifestBody, verifyManifestObject } from "./signing";

// ── Independent Flux `signmessage` signer ────────────────────────────────────
// Same from-scratch wire format as wallet.test.ts: a real regression guard for the
// owner-signature path, not a tautology (it doesn't import wallet.ts's signer).
const b58c = base58check(sha256);
const enc = new TextEncoder();
const dsha256 = (b: Uint8Array): Uint8Array => sha256(sha256(b));
const BITCOIN = "Bitcoin Signed Message:\n"; // ZelID / SSP surface
const V_BTC = Uint8Array.from([0x00]); //          1… P2PKH

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

const OWNER_PRIV = new Uint8Array(32).fill(0x11);
function ownerAddress(priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, true);
  return b58c.encode(concat(V_BTC, ripemd160(sha256(pub))));
}
function walletSign(priv: Uint8Array, message: string): string {
  const sig = secp256k1.sign(magicHash(BITCOIN, message), priv);
  const header = 27 + sig.recovery + 4; // recid + compressed
  return Buffer.from(concat(Uint8Array.from([header]), sig.toCompactRawBytes())).toString("base64");
}

// ── Build a real ed25519-signed manifest with an ownerAddress ────────────────
function buildManifest(owner: string): ProviderManifestT {
  const { publicKeyBase64, privateKey } = generateEd25519();
  const body: Record<string, unknown> = {
    schemaVersion: 2,
    provider: { slug: "test-owner-sig", name: "Test Operator" },
    coalitionUrl: "https://coalition.example",
    pubkey: publicKeyBase64,
    ownerAddress: owner,
    tiers: [{ tier: "nimbus", capacity: 1, storagePool: "local-lvm" }],
    trialDays: 1,
    manualApproval: false,
    serviceFlags: {},
    trustedSelfClaim: false,
    publishedAt: new Date().toISOString(),
  };
  const signature = signManifestBody(body, privateKey);
  const raw = { ...body, signature };
  assert.equal(verifyManifestObject(raw), true, "ed25519 self-signature must verify");
  return ProviderManifest.parse(raw);
}

test("verifyManifestOwnerSignature accepts a wallet-authorized manifest", () => {
  const owner = ownerAddress(OWNER_PRIV);
  const manifest = buildManifest(owner);
  const ownerSignature = walletSign(OWNER_PRIV, manifestOwnerMessage(manifest));
  assert.equal(verifyManifestOwnerSignature(manifest, ownerSignature), true);
  // And the wire wrapper parses.
  assert.equal(SignedProviderManifest.safeParse({ manifest, ownerSignature }).success, true);
});

test("rejects a signature from a different wallet than ownerAddress", () => {
  const manifest = buildManifest(ownerAddress(OWNER_PRIV));
  const otherSig = walletSign(new Uint8Array(32).fill(0x22), manifestOwnerMessage(manifest));
  assert.equal(verifyManifestOwnerSignature(manifest, otherSig), false);
});

test("rejects a signature after the pubkey is swapped (chained to ed25519 sig)", () => {
  const owner = ownerAddress(OWNER_PRIV);
  const manifest = buildManifest(owner);
  const ownerSignature = walletSign(OWNER_PRIV, manifestOwnerMessage(manifest));
  // Attacker keeps the owner signature but swaps in a different pubkey — the message
  // the wallet signed no longer matches, so verification must fail.
  const swapped = { ...manifest, pubkey: buildManifest(owner).pubkey };
  assert.equal(verifyManifestOwnerSignature(swapped, ownerSignature), false);
});

test("returns false (not throw) for a manifest with no ownerAddress", () => {
  const manifest = buildManifest(ownerAddress(OWNER_PRIV));
  const legacy = { ...manifest, ownerAddress: undefined } as ProviderManifestT;
  assert.equal(verifyManifestOwnerSignature(legacy, "AAAA"), false);
  assert.throws(() => manifestOwnerMessage(legacy), /no ownerAddress/);
});

test("unwrapManifest splits a wrapper and passes a bare manifest through", () => {
  const manifest = buildManifest(ownerAddress(OWNER_PRIV));

  // Bare manifest → returned as-is, no ownerSignature.
  const bare = unwrapManifest(manifest);
  assert.equal(bare.manifest, manifest);
  assert.equal(bare.ownerSignature, undefined);

  // SignedProviderManifest wrapper → both parts split out.
  const ownerSignature = walletSign(OWNER_PRIV, manifestOwnerMessage(manifest));
  const wrapped = unwrapManifest({ manifest, ownerSignature });
  assert.equal(wrapped.manifest, manifest);
  assert.equal(wrapped.ownerSignature, ownerSignature);
});
