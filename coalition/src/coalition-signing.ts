import { randomBytes, type KeyObject } from "node:crypto";
import {
  bodyHash,
  importEd25519PrivateKey,
  signRequest,
  type RequestEnvelope,
} from "@moltentech/protocol/signing";
import {
  HEADER_COALITION_SIGNATURE,
  HEADER_COALITION_TIMESTAMP,
  HEADER_COALITION_NONCE,
  HEADER_COALITION_SLUG,
} from "@moltentech/protocol";
import type { CoalitionConfig } from "./config";

/**
 * Coalition-side request signing (Phase D) — the asymmetric replacement for the
 * per-provider `AGENT_KEY` bearer on the Coalition's four outbound reports to MT
 * (`/api/agent/nodes` ×2, `/api/agent/lifecycle`, `/api/agent/payment`).
 *
 * Mirrors `agent/src/signing.ts` exactly, with one deliberate difference: the key.
 * The Coalition signs with `COALITION_SIGNING_KEY` — the private half of
 * `Provider.coalitionPubkey`, issued at ingest — and must NEVER hold the agent's
 * `MANIFEST_KEY`. That key is the operator's rotation identity; confining it to the
 * agent process means a manifest re-key never has to also touch the Coalition, which
 * is redeployed independently (Flux env pushes are all-or-nothing).
 *
 * Dual-accept: with `COALITION_SIGNING_KEY` unset the Coalition keeps sending the
 * legacy bearer, so operators roll one at a time and nobody breaks mid-cutover.
 * `COALITION_SIGNING_KEY` is a SECRET — never commit it, never log it.
 */

/** Load the Coalition signing key (undefined when unset — the bearer path stays). */
export function loadCoalitionKey(value?: string): KeyObject | undefined {
  if (!value) return undefined;
  return importEd25519PrivateKey(value);
}

/**
 * Signature headers for one Coalition → MT request.
 *
 * `method`/`path`/`slug` and the exact `rawBody` serialized on the wire must match what
 * MT re-derives, so a byte-level mismatch in any of them fails verification. `path` is
 * the pathname only — no origin, no query. `rawBody` is `""` for GETs.
 */
export function signCoalitionRequest(
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
    [HEADER_COALITION_SIGNATURE]: signRequest(env, key),
    [HEADER_COALITION_TIMESTAMP]: env.issuedAt,
    [HEADER_COALITION_NONCE]: env.nonce,
    [HEADER_COALITION_SLUG]: slug,
  };
}

/** The config fields every outbound MT call needs to authenticate itself. */
export type MtCallerConfig = Pick<
  CoalitionConfig,
  "providerSlug" | "agentKey" | "coalitionSigningKey"
>;

/**
 * Auth headers for one outbound MT call: signature when a signing key is configured,
 * legacy bearer otherwise.
 *
 * The single place the choice is made, so a fifth outbound call cannot quietly ship on
 * bearer-only. Callers pass the exact `path` and `rawBody` they are about to send —
 * signing anything else produces a valid signature over the wrong request, which MT
 * rejects and which is tedious to diagnose from the 401 alone.
 */
export function mtAuthHeaders(
  cfg: MtCallerConfig,
  method: string,
  path: string,
  rawBody: string,
  key = loadCoalitionKey(cfg.coalitionSigningKey)
): Record<string, string> {
  if (key) return signCoalitionRequest(key, method, path, cfg.providerSlug, rawBody);
  return { Authorization: `Bearer ${cfg.agentKey}` };
}
