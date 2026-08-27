import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  bodyHash,
  checkFreshness,
  exportPrivateKeyPem,
  generateEd25519,
  verifyRequest,
  type RequestEnvelope,
} from "@moltentech/protocol/signing";
import {
  HEADER_COALITION_SIGNATURE,
  HEADER_COALITION_TIMESTAMP,
  HEADER_COALITION_NONCE,
  HEADER_COALITION_SLUG,
} from "@moltentech/protocol";
import { loadCoalitionKey, mtAuthHeaders, signCoalitionRequest } from "./coalition-signing";

const SLUG = "pve25-lab";

/** The wire form `mt-manifest coalition-keygen` emits: base64 of a PKCS#8 PEM. */
function pemKeypair() {
  const { publicKeyBase64, privateKey } = generateEd25519();
  return {
    publicKeyBase64,
    value: Buffer.from(exportPrivateKeyPem(privateKey), "utf8").toString("base64"),
  };
}

/**
 * The wire form MT's `issueProviderKeys()` ACTUALLY hands the operator: base64 of the
 * raw 32-byte seed, produced by keeping the tail of the PKCS#8 DER. Reproduced here
 * byte-for-byte rather than imported, because the whole point of the test is that the
 * two sides agree without sharing code.
 */
function seedKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyBase64: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
    value: privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
  };
}

/** Rebuild the envelope exactly as MT does: trusted method/path/body + header slug/ts/nonce. */
function rebuild(
  headers: Record<string, string>,
  method: string,
  path: string,
  rawBody: string
): RequestEnvelope {
  return {
    method,
    path,
    slug: headers[HEADER_COALITION_SLUG],
    issuedAt: headers[HEADER_COALITION_TIMESTAMP],
    nonce: headers[HEADER_COALITION_NONCE],
    bodyHash: bodyHash(rawBody),
  };
}

test("MT verifies a Coalition signature over the exact request", () => {
  const { publicKeyBase64, value } = seedKeypair();
  const key = loadCoalitionKey(value)!;
  const body = JSON.stringify({ providerSlug: SLUG, nodes: [] });
  const h = signCoalitionRequest(key, "POST", "/api/agent/lifecycle", SLUG, body);

  assert.ok(checkFreshness(h[HEADER_COALITION_TIMESTAMP]));
  assert.ok(
    verifyRequest(
      rebuild(h, "POST", "/api/agent/lifecycle", body),
      h[HEADER_COALITION_SIGNATURE],
      publicKeyBase64
    )
  );
});

test("both issued key forms load: MT's raw 32-byte seed and a PKCS#8 PEM", () => {
  for (const { publicKeyBase64, value } of [seedKeypair(), pemKeypair()]) {
    const key = loadCoalitionKey(value)!;
    const h = signCoalitionRequest(key, "GET", "/api/agent/nodes", SLUG, "");
    assert.ok(
      verifyRequest(rebuild(h, "GET", "/api/agent/nodes", ""), h[HEADER_COALITION_SIGNATURE], publicKeyBase64),
      "a key form MT can issue must verify"
    );
  }
});

test("a tampered body fails: the signature covers sha256(body)", () => {
  const { publicKeyBase64, value } = seedKeypair();
  const key = loadCoalitionKey(value)!;
  const body = JSON.stringify({ amount: 700 });
  const h = signCoalitionRequest(key, "POST", "/api/agent/payment", SLUG, body);

  const tampered = JSON.stringify({ amount: 70000 });
  assert.equal(
    verifyRequest(rebuild(h, "POST", "/api/agent/payment", tampered), h[HEADER_COALITION_SIGNATURE], publicKeyBase64),
    false
  );
});

test("path and method are covered too — a valid signature is not portable", () => {
  const { publicKeyBase64, value } = seedKeypair();
  const key = loadCoalitionKey(value)!;
  const h = signCoalitionRequest(key, "GET", "/api/agent/nodes", SLUG, "");

  assert.equal(verifyRequest(rebuild(h, "GET", "/api/agent/jobs/claim", ""), h[HEADER_COALITION_SIGNATURE], publicKeyBase64), false);
  assert.equal(verifyRequest(rebuild(h, "POST", "/api/agent/nodes", ""), h[HEADER_COALITION_SIGNATURE], publicKeyBase64), false);
});

test("a forged slug fails — the slug is inside the signed envelope", () => {
  const { publicKeyBase64, value } = seedKeypair();
  const key = loadCoalitionKey(value)!;
  const h = signCoalitionRequest(key, "GET", "/api/agent/nodes", SLUG, "");
  const forged = { ...h, [HEADER_COALITION_SLUG]: "someone-elses-provider" };
  assert.equal(verifyRequest(rebuild(forged, "GET", "/api/agent/nodes", ""), h[HEADER_COALITION_SIGNATURE], publicKeyBase64), false);
});

test("the wrong provider's pubkey rejects a well-formed signature", () => {
  const mine = seedKeypair();
  const theirs = seedKeypair();
  const key = loadCoalitionKey(mine.value)!;
  const h = signCoalitionRequest(key, "GET", "/api/agent/nodes", SLUG, "");
  assert.equal(verifyRequest(rebuild(h, "GET", "/api/agent/nodes", ""), h[HEADER_COALITION_SIGNATURE], theirs.publicKeyBase64), false);
});

test("stale timestamps are outside the freshness window", () => {
  assert.equal(checkFreshness(new Date(Date.now() - 10 * 60_000).toISOString()), false);
  assert.equal(checkFreshness("not-a-date"), false);
});

test("nonces are single-use per request, never reused across calls", () => {
  const { value } = seedKeypair();
  const key = loadCoalitionKey(value)!;
  const a = signCoalitionRequest(key, "GET", "/api/agent/nodes", SLUG, "");
  const b = signCoalitionRequest(key, "GET", "/api/agent/nodes", SLUG, "");
  assert.notEqual(a[HEADER_COALITION_NONCE], b[HEADER_COALITION_NONCE]);
});

test("dual-accept: no signing key configured keeps the legacy bearer", () => {
  const h = mtAuthHeaders(
    { providerSlug: SLUG, agentKey: "legacy-agent-key-value", coalitionSigningKey: undefined },
    "GET",
    "/api/agent/nodes",
    ""
  );
  assert.deepEqual(h, { Authorization: "Bearer legacy-agent-key-value" });
});

test("with a signing key configured the bearer is GONE, not sent alongside", () => {
  const { value } = seedKeypair();
  const h = mtAuthHeaders(
    { providerSlug: SLUG, agentKey: "legacy-agent-key-value", coalitionSigningKey: value },
    "GET",
    "/api/agent/nodes",
    ""
  );
  assert.equal(h.Authorization, undefined);
  assert.ok(h[HEADER_COALITION_SIGNATURE]);
  assert.equal(h[HEADER_COALITION_SLUG], SLUG);
});

test("a garbage COALITION_SIGNING_KEY throws at load, it does not silently fall back", () => {
  // Silently dropping to bearer here would make a mis-pasted key look like a working
  // cutover: the reports keep succeeding and via=bearer is the only tell.
  assert.throws(() => loadCoalitionKey("not-base64-at-all!!"));
});
