import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

/**
 * Manifest signing (ed25519) — the ONE shared definition so the operator's signing
 * CLI and MT's verifier agree byte-for-byte. Server-only (uses node:crypto); import
 * from "@moltentech/protocol/signing", never from the package root, so client
 * bundles never pull node:crypto.
 *
 * Canonicalization: deterministic JSON with object keys sorted recursively and no
 * whitespace; arrays keep their order. The signature is detached and covers the
 * canonical bytes of the manifest body with the `signature` key REMOVED (so the
 * signer signs exactly what the verifier re-derives from the published document).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** Build a node KeyObject from a base64 raw 32-byte ed25519 public key. */
function ed25519PublicFromBase64(pubkeyB64: string): KeyObject {
  const x = Buffer.from(pubkeyB64, "base64").toString("base64url");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

/** Verify a detached ed25519 signature (base64) over the given canonical string. */
export function verifyDetached(
  canonical: string,
  signatureB64: string,
  pubkeyB64: string
): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonical, "utf8"),
      ed25519PublicFromBase64(pubkeyB64),
      Buffer.from(signatureB64, "base64")
    );
  } catch {
    return false;
  }
}

/**
 * Verify a raw fetched manifest object `{ signature, ...body }`: canonicalize the
 * body (signature excluded) and check it against the body's own `pubkey`. Trust in
 * that pubkey is established out-of-band (admin approves it at onboarding; re-ingest
 * must match the stored key).
 */
export function verifyManifestObject(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  const { signature, ...body } = obj;
  if (typeof signature !== "string" || typeof body.pubkey !== "string") return false;
  return verifyDetached(canonicalize(body), signature, body.pubkey);
}

// ── Operator-side signing (used by the manifest signing CLI; MT never signs) ──

/** Generate an ed25519 keypair; returns the public key as base64 raw + the private KeyObject. */
export function generateEd25519(): { publicKeyBase64: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return { publicKeyBase64: Buffer.from(jwk.x, "base64url").toString("base64"), privateKey };
}

/** Sign a manifest body (signature key absent) → detached signature, base64. */
export function signManifestBody(body: Record<string, unknown>, privateKey: KeyObject): string {
  return sign(null, Buffer.from(canonicalize(body), "utf8"), privateKey).toString("base64");
}

/** Export a private key as PKCS#8 PEM (what the operator stores on disk, 0600). */
export function exportPrivateKeyPem(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }) as string;
}

/** Load a private key from PKCS#8 PEM. */
export function importPrivateKeyPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

/** Derive the base64 raw ed25519 public key (the manifest `pubkey`) from a private key. */
export function publicKeyBase64FromPrivate(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url").toString("base64");
}
