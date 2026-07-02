import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { base58check } from "@scure/base";
import {
  SCHEMA_VERSION,
  Job,
  ownerAuthMessage,
  type JobAction,
  type OwnerAuth,
  type OwnerAuthClaim,
} from "@moltentech/protocol";
import type { AgentConfig } from "./config";
import { checkOwnerAuth } from "./owner-auth";

// ── Independent Flux signer (mirrors wallet.test.ts) ─────────────────────────
const b58c = base58check(sha256);
const enc = new TextEncoder();
const dsha256 = (b: Uint8Array): Uint8Array => sha256(sha256(b));
const BITCOIN = "Bitcoin Signed Message:\n";
const V_BTC = Uint8Array.from([0x00]); // ZelID / SSP  1…
const PRIV = new Uint8Array(32).fill(0x11);

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
function magicHash(message: string): Uint8Array {
  const m = enc.encode(BITCOIN);
  const g = enc.encode(message);
  return dsha256(concat(varint(m.length), m, varint(g.length), g));
}

/** Sign a claim with PRIV → the OwnerAuth blob + the address to pin it against. */
function signOwnerAuth(claim: OwnerAuthClaim, priv = PRIV): { address: string; auth: OwnerAuth } {
  const pub = secp256k1.getPublicKey(priv, true);
  const sig = secp256k1.sign(magicHash(ownerAuthMessage(claim)), priv);
  const header = 27 + sig.recovery + 4;
  const signature = Buffer.from(
    concat(Uint8Array.from([header]), sig.toCompactRawBytes())
  ).toString("base64");
  const address = b58c.encode(concat(V_BTC, ripemd160(sha256(pub))));
  return { address, auth: { ...claim, signature } };
}

const cfgWith = (ownerAddress?: string): AgentConfig => ({ ownerAddress }) as unknown as AgentConfig;

function makeJob(action: JobAction, ownerAuth?: OwnerAuth): Job {
  return Job.parse({
    schemaVersion: SCHEMA_VERSION,
    jobId: "job-1",
    providerSlug: "pve25-lab",
    action,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    slot: {
      vmName: "molten-nimbus-01",
      tier: "nimbus",
      nodeName: "pve25",
      ipAddress: "192.168.1.10",
      gateway: "192.168.1.1",
      apiPort: 16127,
    },
    ...(ownerAuth ? { ownerAuth } : {}),
  });
}

/** A claim bound to makeJob()'s slot, with a unique nonce per test. */
function claimFor(action: JobAction, nonce: string): OwnerAuthClaim {
  return {
    action,
    providerSlug: "pve25-lab",
    vmName: "molten-nimbus-01",
    nodeName: "pve25",
    nonce,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test("provision is never gated (no auth, no owner pinned)", () => {
  assert.deepEqual(checkOwnerAuth(makeJob("provision"), cfgWith()), { ok: true });
});

test("privileged action is allowed when no owner is pinned (enforcement off)", () => {
  assert.deepEqual(checkOwnerAuth(makeJob("delete"), cfgWith()), { ok: true });
});

test("privileged action is refused when pinned but no authorization is present", () => {
  const r = checkOwnerAuth(makeJob("delete"), cfgWith("1SomeOwnerAddress"));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "missing owner authorization");
});

test("a valid, bound authorization is accepted", () => {
  const { address, auth } = signOwnerAuth(claimFor("delete", "n-ok-1"));
  assert.deepEqual(checkOwnerAuth(makeJob("delete", auth), cfgWith(address)), { ok: true });
});

test("an authorization for a different vm is refused (does not bind)", () => {
  const { address, auth } = signOwnerAuth({ ...claimFor("delete", "n-bind-1"), vmName: "other-vm" });
  const r = checkOwnerAuth(makeJob("delete", auth), cfgWith(address));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "authorization does not bind to this job");
});

test("an authorization for a different action is refused (does not bind)", () => {
  // Signed for delete, but attached to a move job.
  const { address, auth } = signOwnerAuth(claimFor("delete", "n-bind-2"));
  const r = checkOwnerAuth(makeJob("move", auth), cfgWith(address));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "authorization does not bind to this job");
});

test("an authorization signed by a different owner is refused", () => {
  const { auth } = signOwnerAuth(claimFor("delete", "n-owner-1"));
  // Pin a different owner's address.
  const otherPub = secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), true);
  const otherAddr = b58c.encode(concat(V_BTC, ripemd160(sha256(otherPub))));
  assert.equal(checkOwnerAuth(makeJob("delete", auth), cfgWith(otherAddr)).ok, false);
});

test("an expired authorization is refused", () => {
  const { address, auth } = signOwnerAuth({
    ...claimFor("delete", "n-exp-1"),
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const r = checkOwnerAuth(makeJob("delete", auth), cfgWith(address));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "authorization expired");
});

test("a replayed authorization (same nonce) is refused the second time", () => {
  const { address, auth } = signOwnerAuth(claimFor("reprovision", "n-replay-1"));
  const job = makeJob("reprovision", auth);
  assert.deepEqual(checkOwnerAuth(job, cfgWith(address)), { ok: true });
  const second = checkOwnerAuth(job, cfgWith(address));
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.reason, "owner authorization already used (replay)");
});
