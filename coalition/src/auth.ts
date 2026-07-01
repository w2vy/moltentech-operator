import type { IncomingHttpHeaders } from "node:http";
import {
  bodyHash,
  checkFreshness,
  verifyRequest,
  type RequestEnvelope,
} from "@moltentech/protocol/signing";
import type { CoalitionConfig } from "./config";

/**
 * Authenticate an inbound MT → Coalition request on /checkout and /manage.
 *
 * Preferred path (Phase A): MT signs a request envelope with the global MT key
 * (`X-MT-Signature`, ed25519). We rebuild the envelope from what we already trust
 * locally — our OWN provider slug, the actual method/path, and the sha256 of the
 * actual body — and take only `issuedAt`/`nonce` from headers, so a byte-level
 * mismatch in path, slug, or body fails verification.
 *
 * Dual-accept fallback: the legacy MT-issued symmetric `coalitionKey` bearer is
 * still accepted while operators/MT roll to signatures. Drops in Phase D.
 */

const NONCE_TTL_MS = 5 * 60_000; // > the ±120s freshness window
const seenNonces = new Map<string, number>(); // nonce -> expiry (ms epoch)

/** Record a nonce; false if it was already seen (replay). Prunes expired entries. */
function rememberNonce(nonce: string): boolean {
  const now = Date.now();
  for (const [n, exp] of seenNonces) if (exp <= now) seenNonces.delete(n);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now + NONCE_TTL_MS);
  return true;
}

export type AuthResult =
  | { ok: true; via: "signature" | "bearer" }
  | { ok: false; status: number; error: string };

export function verifyMtRequest(
  cfg: CoalitionConfig,
  method: string,
  path: string,
  rawBody: Buffer,
  headers: IncomingHttpHeaders
): AuthResult {
  const signature = headers["x-mt-signature"];

  // Asymmetric path — only attempted when both a signature and a pinned MT pubkey exist.
  if (typeof signature === "string" && cfg.mtPubkey) {
    const issuedAt = headers["x-mt-timestamp"];
    const nonce = headers["x-mt-nonce"];
    if (typeof issuedAt !== "string" || typeof nonce !== "string") {
      return { ok: false, status: 401, error: "Unauthorized" };
    }
    if (!checkFreshness(issuedAt)) {
      return { ok: false, status: 401, error: "Stale request" };
    }
    const env: RequestEnvelope = {
      method,
      path,
      slug: cfg.providerSlug,
      issuedAt,
      nonce,
      bodyHash: bodyHash(rawBody),
    };
    if (!verifyRequest(env, signature, cfg.mtPubkey)) {
      return { ok: false, status: 401, error: "Unauthorized" };
    }
    // Only burn the nonce once the signature is valid (so bad sigs can't evict good nonces).
    if (!rememberNonce(nonce)) {
      return { ok: false, status: 401, error: "Replay detected" };
    }
    return { ok: true, via: "signature" };
  }

  // Dual-accept fallback: legacy MT-issued symmetric bearer.
  if (headers["authorization"] === `Bearer ${cfg.coalitionKey}`) {
    return { ok: true, via: "bearer" };
  }

  return { ok: false, status: 401, error: "Unauthorized" };
}
