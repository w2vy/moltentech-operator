import { randomBytes, type KeyObject } from "node:crypto";
import {
  bodyHash,
  importPrivateKeyPem,
  signRequest,
  type RequestEnvelope,
} from "@moltentech/protocol/signing";
import {
  HEADER_AGENT_SIGNATURE,
  HEADER_AGENT_TIMESTAMP,
  HEADER_AGENT_NONCE,
  HEADER_AGENT_SLUG,
} from "@moltentech/protocol";

/**
 * Agent-side request signing (Phase B) — the asymmetric replacement for the
 * per-provider `AGENT_KEY` bearer on agent → MT calls. The agent reuses its
 * manifest ed25519 key (the private half of the pubkey MT pinned as
 * `Provider.manifestPubkey`) to sign a canonical request envelope; MT re-derives
 * the envelope and verifies it against that pubkey. When `MANIFEST_KEY` is unset
 * the agent falls back to the legacy bearer, so operators roll independently.
 *
 * `MANIFEST_KEY` is the base64 of the PKCS#8 PEM (single-line env value) of the
 * key produced by `mt-manifest keygen`. It is a SECRET — never commit it.
 */

/** Load the manifest private key from a base64 PKCS#8 PEM env value (undefined if unset). */
export function loadManifestKey(pemB64?: string): KeyObject | undefined {
  if (!pemB64) return undefined;
  return importPrivateKeyPem(Buffer.from(pemB64, "base64").toString("utf8"));
}

/**
 * Signature headers for one agent → MT request. `method`/`path`/`slug` and the
 * exact `rawBody` serialized on the wire must match what MT re-derives, so a
 * byte-level mismatch in any of them fails verification. `rawBody` is `""` for
 * empty-body requests (e.g. `claim`, `nodes`).
 */
export function signAgentRequest(
  key: KeyObject,
  method: string,
  path: string,
  slug: string,
  rawBody: string
): Record<string, string> {
  const env: RequestEnvelope = {
    method,
    path,
    slug,
    issuedAt: new Date().toISOString(),
    nonce: randomBytes(16).toString("hex"),
    bodyHash: bodyHash(rawBody),
  };
  return {
    [HEADER_AGENT_SIGNATURE]: signRequest(env, key),
    [HEADER_AGENT_TIMESTAMP]: env.issuedAt,
    [HEADER_AGENT_NONCE]: env.nonce,
    [HEADER_AGENT_SLUG]: slug,
  };
}
