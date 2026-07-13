import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateEd25519,
  signRequest,
  bodyHash,
  type RequestEnvelope,
} from "@moltentech/protocol/signing";
import {
  HEADER_AGENT_SIGNATURE,
  HEADER_AGENT_TIMESTAMP,
  HEADER_AGENT_NONCE,
  HEADER_AGENT_SLUG,
} from "@moltentech/protocol";
import type { KeyObject } from "node:crypto";
import { randomBytes } from "node:crypto";
import { handleAgentPending } from "./console";
import type { CoalitionConfig } from "./config";

// Agent auth on the Coalition verifies the request against the pubkey read out of the
// SERVED manifest (`manifestPubkey` → `manifest()` → `unwrapManifest`). This guards
// that a manifest published as a SignedProviderManifest *wrapper* (the owner-signed
// onboarding payload) still yields a working agent-auth pubkey — i.e. wrapping the
// manifest for MT ingest doesn't break the Coalition's own consumer of it.

const SLUG = "pve25-lab";
const agent = generateEd25519(); // stands in for the operator's manifest keypair

// The served blob is the *wrapper* {manifest, ownerSignature}, not a bare manifest.
const WRAPPED_MANIFEST_JSON = JSON.stringify({
  manifest: {
    schemaVersion: 2,
    provider: { slug: SLUG, name: "Lab Operator" },
    coalitionUrl: "https://coalition.example",
    pubkey: agent.publicKeyBase64,
    ownerAddress: "t1exampleOwnerWalletAddress",
    tiers: [{ tier: "nimbus", capacity: 1, storagePool: "local-lvm" }],
    trialDays: 1,
    manualApproval: false,
    serviceFlags: {},
    trustedSelfClaim: false,
    publishedAt: new Date().toISOString(),
    signature: "not-checked-by-agent-auth",
  },
  ownerSignature: "not-checked-by-agent-auth",
});

function cfg(): CoalitionConfig {
  return {
    port: 8088,
    providerSlug: SLUG,
    mtBaseUrl: "https://mt.example",
    agentKey: "agent-key",
    coalitionKey: "bearer",
    stripeSecretKey: "sk_test",
    stripeWebhookSecret: "whsec",
    manifestPath: "./manifest.json",
    manifestJson: WRAPPED_MANIFEST_JSON,
    tierPrices: {},
    trialDays: 1,
    statsWindowDays: 90,
    fluxApiUrl: "https://api.runonflux.io",
    sessionTtlMs: 86_400_000,
  };
}

function signedHeaders(key: KeyObject, rawBody: string): Record<string, string> {
  const env: RequestEnvelope = {
    method: "POST",
    path: "/agent/pending",
    slug: SLUG,
    issuedAt: new Date().toISOString(),
    nonce: randomBytes(16).toString("hex"),
    bodyHash: bodyHash(rawBody),
  };
  return {
    [HEADER_AGENT_SIGNATURE]: signRequest(env, key),
    [HEADER_AGENT_TIMESTAMP]: env.issuedAt,
    [HEADER_AGENT_NONCE]: env.nonce,
    [HEADER_AGENT_SLUG]: SLUG,
  };
}

test("agent auth accepts a request signed by the wrapped manifest's key", () => {
  const rawBody = JSON.stringify({ items: [] });
  const res = handleAgentPending(cfg(), Buffer.from(rawBody), signedHeaders(agent.privateKey, rawBody));
  // Auth passed (the wrapper's inner pubkey was extracted) → the pending list is accepted.
  assert.equal(res.status, 200);
});

test("agent auth rejects a request signed by a different key", () => {
  const other = generateEd25519();
  const rawBody = JSON.stringify({ items: [] });
  const res = handleAgentPending(cfg(), Buffer.from(rawBody), signedHeaders(other.privateKey, rawBody));
  assert.equal(res.status, 401);
});
