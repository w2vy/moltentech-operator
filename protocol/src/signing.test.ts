import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bodyHash,
  checkFreshness,
  generateEd25519,
  signRequest,
  verifyRequest,
  type RequestEnvelope,
} from "./signing";

function sampleEnvelope(): RequestEnvelope {
  return {
    method: "POST",
    path: "/api/agent/claim",
    slug: "pve25-lab",
    issuedAt: new Date().toISOString(),
    nonce: "d0f3a1c29b7e4f10",
    bodyHash: bodyHash(""),
  };
}

test("request envelope round-trips sign → verify", () => {
  const { publicKeyBase64, privateKey } = generateEd25519();
  const env = sampleEnvelope();
  const sig = signRequest(env, privateKey);
  assert.equal(verifyRequest(env, sig, publicKeyBase64), true);
});

test("verification fails when any envelope field is tampered", () => {
  const { publicKeyBase64, privateKey } = generateEd25519();
  const env = sampleEnvelope();
  const sig = signRequest(env, privateKey);

  for (const tamper of [
    { ...env, path: "/api/agent/claim-other" },
    { ...env, method: "GET" },
    { ...env, slug: "other-provider" },
    { ...env, nonce: "deadbeefdeadbeef" },
    { ...env, bodyHash: bodyHash("x") },
  ]) {
    assert.equal(verifyRequest(tamper, sig, publicKeyBase64), false);
  }
});

test("verification fails against a different public key", () => {
  const signer = generateEd25519();
  const other = generateEd25519();
  const env = sampleEnvelope();
  const sig = signRequest(env, signer.privateKey);
  assert.equal(verifyRequest(env, sig, other.publicKeyBase64), false);
});

test("bodyHash is stable sha256 hex", () => {
  assert.equal(
    bodyHash(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
  assert.equal(
    bodyHash("hello"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  );
  // string and Buffer inputs agree
  assert.equal(bodyHash("hello"), bodyHash(Buffer.from("hello")));
});

test("checkFreshness accepts now, rejects stale and unparseable", () => {
  assert.equal(checkFreshness(new Date().toISOString()), true);
  assert.equal(
    checkFreshness(new Date(Date.now() - 10 * 60 * 1000).toISOString()),
    false
  );
  // within a tight custom skew a 5s-old stamp is stale
  assert.equal(
    checkFreshness(new Date(Date.now() - 5000).toISOString(), { skewMs: 1000 }),
    false
  );
  assert.equal(checkFreshness("not-a-date"), false);
});
