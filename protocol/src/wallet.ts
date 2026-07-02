import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { hexToBytes } from "@noble/hashes/utils";
import { base58check } from "@scure/base";
import { ownerAuthMessage, type OwnerAuth } from "./messages";

/**
 * Flux / Bitcoin "sign message" verification (secp256k1) — the owner-authorization
 * primitive (Phase 0a). An owner proves consent to a privileged action by signing
 * the canonical action message with their Flux wallet; the operator verifies that
 * signature here against a self-pinned wallet address (never trusting MT).
 *
 * Wire format was proven empirically against a real Zelcore signature (design memo
 * `project_moltentech_asymmetric_signing`). Two magic prefixes cover all three Flux
 * signing surfaces, everything else identical:
 *   - Flux wallet (Zelcore), `t1…` P2PKH (version [0x1c,0xb8]) → "Zelcash Signed Message:\n"
 *   - ZelID and SSP, `1…` P2PKH (version 0x00)                 → "Bitcoin Signed Message:\n"
 * Signature is a 65-byte compact *recoverable* secp256k1 sig, base64. The header
 * byte encodes the recovery id `(h-27)&3` and key compression `(h-27)&4`, so the
 * pubkey is recovered directly — no brute force. The address version byte(s) come
 * from decoding the claimed address, so we never assume which surface signed; we
 * just try both magics and check the recovered address matches.
 *
 * Server-only (secp256k1). Import from "@moltentech/protocol/wallet".
 */

const b58c = base58check(sha256);
const enc = new TextEncoder();
const dsha256 = (b: Uint8Array): Uint8Array => sha256(sha256(b));

/** The two proven Flux/Bitcoin message magics. */
const MAGICS = ["Bitcoin Signed Message:\n", "Zelcash Signed Message:\n"] as const;

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.from([n]);
  if (n <= 0xffff) return Uint8Array.from([0xfd, n & 0xff, n >> 8]);
  throw new Error("message too long");
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

/** Bitcoin-family message hash: dSHA256(varint(len)‖magic ‖ varint(len)‖message). */
function magicHash(magic: string, message: string): Uint8Array {
  const m = enc.encode(magic);
  const g = enc.encode(message);
  return dsha256(concat(varint(m.length), m, varint(g.length), g));
}

/**
 * Verify a Flux/Bitcoin `signmessage` signature.
 *
 * @param address  the signer's claimed address (`t1…` Flux, or `1…` ZelID/SSP)
 * @param message  the exact signed message (e.g. a canonical action string)
 * @param sigB64   65-byte compact recoverable signature, base64
 * @returns true iff `sigB64` recovers to `address` for the given `message`
 */
export function verifyFluxSignature(
  address: string,
  message: string,
  sigB64: string
): boolean {
  // Decode the address to recover its version byte(s): payload = version ‖ hash160(20).
  let payload: Uint8Array;
  try {
    payload = b58c.decode(address);
  } catch {
    return false;
  }
  if (payload.length < 21) return false;
  const versionBytes = payload.slice(0, payload.length - 20);

  let sig: Buffer;
  try {
    sig = Buffer.from(sigB64, "base64");
  } catch {
    return false;
  }
  if (sig.length !== 65) return false;

  const header = sig[0]!;
  if (header < 27 || header > 34) return false;
  const recid = (header - 27) & 3;
  const compressed = ((header - 27) & 4) !== 0;
  const compact = sig.subarray(1, 65);

  for (const magic of MAGICS) {
    try {
      const h = magicHash(magic, message);
      const pub = secp256k1.Signature.fromCompact(compact)
        .addRecoveryBit(recid)
        .recoverPublicKey(h);
      const pk = pub.toRawBytes(compressed);
      const recovered = b58c.encode(concat(versionBytes, ripemd160(sha256(pk))));
      if (recovered === address) return true;
    } catch {
      // wrong magic (or unrecoverable for this recid) → try the next
    }
  }
  return false;
}

/**
 * Verify an owner authorization for a privileged action (Phase C). Checks the
 * authorization is unexpired and that its signature over the canonical
 * `ownerAuthMessage` recovers to the operator's SELF-PINNED owner address — never
 * a value supplied by MT. Returns a reason on failure for operator logs.
 *
 * The caller still must (1) confirm the claim's action/provider/vm/node match the
 * job it is about to run, and (2) reject a replayed `nonce` (a per-operator store,
 * like the request-envelope nonce) — neither is checkable from the signature alone.
 */
export function verifyOwnerAuth(
  auth: OwnerAuth,
  pinnedOwnerAddress: string,
  opts?: { now?: number }
): { ok: true } | { ok: false; reason: string } {
  const now = opts?.now ?? Date.now();
  const exp = Date.parse(auth.expiresAt);
  if (Number.isNaN(exp)) return { ok: false, reason: "invalid expiresAt" };
  if (exp <= now) return { ok: false, reason: "authorization expired" };
  if (!verifyFluxSignature(pinnedOwnerAddress, ownerAuthMessage(auth), auth.signature)) {
    return { ok: false, reason: "signature does not match the pinned owner address" };
  }
  return { ok: true };
}

const SIGN_MAGIC = { zelid: "Bitcoin Signed Message:\n", flux: "Zelcash Signed Message:\n" } as const;
const SIGN_VERSION = { zelid: Uint8Array.from([0x00]), flux: Uint8Array.from([0x1c, 0xb8]) } as const;

/**
 * Produce a Flux/Bitcoin `signmessage` signature over `message` with a raw private
 * key. Returns the signer's address and the 65-byte compact recoverable base64
 * signature — the inverse of `verifyFluxSignature`. For the headless `mt-authorize`
 * path; the preferred owner flow signs in Zelcore/ZelID so the private key never
 * leaves the wallet. `type` picks the address surface: `zelid` (Bitcoin magic, `1…`)
 * or `flux` (Zelcash magic, `t1…`).
 */
export function signFluxMessage(
  privateKey: string | Uint8Array,
  message: string,
  opts?: { type?: "zelid" | "flux" }
): { address: string; signature: string } {
  const type = opts?.type ?? "zelid";
  const priv = typeof privateKey === "string" ? hexToBytes(privateKey.replace(/^0x/, "")) : privateKey;
  const pub = secp256k1.getPublicKey(priv, true);
  const sig = secp256k1.sign(magicHash(SIGN_MAGIC[type], message), priv);
  const header = 27 + sig.recovery + 4; // recovery id + compressed-key flag
  const signature = Buffer.from(
    concat(Uint8Array.from([header]), sig.toCompactRawBytes())
  ).toString("base64");
  const address = b58c.encode(concat(SIGN_VERSION[type], ripemd160(sha256(pub))));
  return { address, signature };
}
