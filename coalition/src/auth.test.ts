import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import {
  bodyHash,
  generateEd25519,
  signRequest,
  type RequestEnvelope,
} from "@moltentech/protocol/signing";
import { verifyMtRequest } from "./auth";
import type { CoalitionConfig } from "./config";

const mt = generateEd25519(); // the global MT key under test

const BEARER = "legacy-bearer-secret";
const SLUG = "pve25-lab";

function cfg(over: Partial<CoalitionConfig> = {}): CoalitionConfig {
  return {
    port: 8088,
    providerSlug: SLUG,
    mtBaseUrl: "https://mt.example",
    legacyBearersPresent: [],
    coalitionSigningKey: "unused-by-the-inbound-verifier",
    stripeSecretKey: "sk_test",
    stripeWebhookSecret: "whsec",
    manifestPath: "./manifest.json",
    tierPrices: {},
    trialDays: 1,
    statsWindowDays: 90,
    fluxApiUrl: "https://api.runonflux.io",
    sessionTtlMs: 86_400_000,
    mtPubkey: mt.publicKeyBase64,
    ...over,
  };
}

let nonceSeq = 0;
function envFor(raw: Buffer, over: Partial<RequestEnvelope> = {}): RequestEnvelope {
  return {
    method: "POST",
    path: "/checkout",
    slug: SLUG,
    issuedAt: new Date().toISOString(),
    nonce: `nonce-${nonceSeq++}`,
    bodyHash: bodyHash(raw),
    ...over,
  };
}

function headersFor(env: RequestEnvelope): IncomingHttpHeaders {
  return {
    "x-mt-signature": signRequest(env, mt.privateKey),
    "x-mt-timestamp": env.issuedAt,
    "x-mt-nonce": env.nonce,
  };
}

const BODY = Buffer.from(JSON.stringify({ tier: "nimbus" }));

test("valid signature authenticates via signature", () => {
  const res = verifyMtRequest(cfg(), "POST", "/checkout", BODY, headersFor(envFor(BODY)));
  assert.deepEqual(res, { ok: true, via: "signature" });
});

test("wrong bearer is rejected", () => {
  const res = verifyMtRequest(cfg(), "POST", "/checkout", BODY, {
    authorization: "Bearer nope",
  });
  assert.equal(res.ok, false);
});

test("tampered body fails (bodyHash mismatch)", () => {
  const headers = headersFor(envFor(BODY));
  const res = verifyMtRequest(cfg(), "POST", "/checkout", Buffer.from("{}"), headers);
  assert.equal(res.ok, false);
});

test("mismatched path fails", () => {
  const headers = headersFor(envFor(BODY, { path: "/checkout" }));
  const res = verifyMtRequest(cfg(), "POST", "/manage", BODY, headers);
  assert.equal(res.ok, false);
});

test("signature for a different provider slug fails", () => {
  const headers = headersFor(envFor(BODY, { slug: "someone-else" }));
  const res = verifyMtRequest(cfg(), "POST", "/checkout", BODY, headers);
  assert.equal(res.ok, false);
});

test("stale timestamp is rejected", () => {
  const env = envFor(BODY, {
    issuedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  });
  const res = verifyMtRequest(cfg(), "POST", "/checkout", BODY, headersFor(env));
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error, "Stale request");
});

test("replayed nonce is rejected on the second use", () => {
  const headers = headersFor(envFor(BODY));
  const first = verifyMtRequest(cfg(), "POST", "/checkout", BODY, headers);
  assert.equal(first.ok, true);
  const second = verifyMtRequest(cfg(), "POST", "/checkout", BODY, headers);
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.error, "Replay detected");
});

test("a bad signature does not burn the nonce", () => {
  const env = envFor(BODY);
  const good = headersFor(env);
  const bad = { ...good, "x-mt-signature": signRequest(envFor(BODY), mt.privateKey) };
  // `bad` carries env's nonce/timestamp but a signature over a DIFFERENT envelope.
  const rejected = verifyMtRequest(cfg(), "POST", "/checkout", BODY, bad);
  assert.equal(rejected.ok, false);
  // The good request with the same nonce must still succeed.
  const accepted = verifyMtRequest(cfg(), "POST", "/checkout", BODY, good);
  assert.deepEqual(accepted, { ok: true, via: "signature" });
});

// ── Phase E step 4, 2026-09-07: the bearer is GONE ───────────────────────────────────
// These replace the dual-accept tests. The previous versions asserted that a bearer was
// accepted, and one asserted that an UNSET key must not accept the literal string
// "Bearer undefined" — a good guard, now moot because there is no key to interpolate.

test("🔒 a bearer is REFUSED — a signature is the only way in", () => {
  // The exact credential the old dual-accept path honoured. MT dropped the column that
  // issued it, so nothing can present a valid one; this asserts we would refuse it even
  // if something did.
  const r = verifyMtRequest(cfg(), "POST", "/checkout", BODY, {
    authorization: `Bearer ${BEARER}`,
  });
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 401);
});

test("🔒 `Bearer undefined` is refused — there is no key left to interpolate", () => {
  const r = verifyMtRequest(cfg(), "POST", "/checkout", Buffer.from(""), {
    authorization: "Bearer undefined",
  });
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 401);
});

test("🔒 with no pinned MT pubkey there is no way in at all — bearer no longer rescues it", () => {
  // `mtPubkey` is `req()`d at config load, so this shape should be unreachable. It is
  // asserted anyway: this is the case that USED to fall through to the bearer, and the
  // failure mode of getting it wrong is silent acceptance rather than a crash.
  const noKey = cfg({ mtPubkey: undefined as unknown as string });
  const sigOnly = verifyMtRequest(noKey, "POST", "/checkout", BODY, headersFor(envFor(BODY)));
  assert.equal(sigOnly.ok, false);
  const withBearer = verifyMtRequest(noKey, "POST", "/checkout", BODY, {
    authorization: `Bearer ${BEARER}`,
  });
  assert.equal(withBearer.ok, false);
});

test("a valid MT signature is still admitted", () => {
  const c = cfg();
  const issuedAt = new Date().toISOString();
  const nonce = "nonce-phase-e-1";
  const env = {
    method: "POST",
    path: "/checkout",
    slug: SLUG,
    issuedAt,
    nonce,
    bodyHash: bodyHash(Buffer.from("")),
  };
  const r = verifyMtRequest(c, "POST", "/checkout", Buffer.from(""), {
    "x-mt-signature": signRequest(env, mt.privateKey),
    "x-mt-timestamp": issuedAt,
    "x-mt-nonce": nonce,
  });
  assert.equal(r.ok, true);
  assert.equal((r as { via: string }).via, "signature");
});
