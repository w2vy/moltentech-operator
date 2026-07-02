import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bodyHash,
  checkFreshness,
  exportPrivateKeyPem,
  generateEd25519,
  verifyRequest,
  type RequestEnvelope,
} from "@moltentech/protocol/signing";
import {
  HEADER_AGENT_SIGNATURE,
  HEADER_AGENT_TIMESTAMP,
  HEADER_AGENT_NONCE,
  HEADER_AGENT_SLUG,
} from "@moltentech/protocol";
import { loadManifestKey, signAgentRequest } from "./signing";

const SLUG = "pve25-lab";

function keypair() {
  const { publicKeyBase64, privateKey } = generateEd25519();
  const pemB64 = Buffer.from(exportPrivateKeyPem(privateKey), "utf8").toString("base64");
  return { publicKeyBase64, pemB64 };
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
    slug: headers[HEADER_AGENT_SLUG]!,
    issuedAt: headers[HEADER_AGENT_TIMESTAMP]!,
    nonce: headers[HEADER_AGENT_NONCE]!,
    bodyHash: bodyHash(rawBody),
  };
}

/** The detached signature header from a signed request (asserted present). */
const sig = (h: Record<string, string>): string => h[HEADER_AGENT_SIGNATURE]!;

test("loadManifestKey returns undefined when unset", () => {
  assert.equal(loadManifestKey(undefined), undefined);
  assert.equal(loadManifestKey(""), undefined);
});

test("signed request verifies against the manifest pubkey (empty body)", () => {
  const { publicKeyBase64, pemB64 } = keypair();
  const key = loadManifestKey(pemB64)!;
  const h = signAgentRequest(key, "POST", "/api/agent/jobs/claim", SLUG, "");
  const env = rebuild(h, "POST", "/api/agent/jobs/claim", "");
  assert.ok(verifyRequest(env, sig(h), publicKeyBase64));
  assert.ok(checkFreshness(h[HEADER_AGENT_TIMESTAMP]!));
  assert.equal(h[HEADER_AGENT_SLUG], SLUG);
});

test("signed request verifies with a JSON body", () => {
  const { publicKeyBase64, pemB64 } = keypair();
  const key = loadManifestKey(pemB64)!;
  const raw = JSON.stringify({ jobId: "j1", status: "success" });
  const h = signAgentRequest(key, "POST", "/api/agent/jobs/j1/result", SLUG, raw);
  const env = rebuild(h, "POST", "/api/agent/jobs/j1/result", raw);
  assert.ok(verifyRequest(env, sig(h), publicKeyBase64));
});

test("a tampered body fails verification", () => {
  const { publicKeyBase64, pemB64 } = keypair();
  const key = loadManifestKey(pemB64)!;
  const raw = JSON.stringify({ jobId: "j1", status: "success" });
  const h = signAgentRequest(key, "POST", "/api/agent/jobs/j1/result", SLUG, raw);
  const env = rebuild(h, "POST", "/api/agent/jobs/j1/result", raw + " ");
  assert.equal(verifyRequest(env, sig(h), publicKeyBase64), false);
});

test("a tampered slug (impersonation) fails verification", () => {
  const { publicKeyBase64, pemB64 } = keypair();
  const key = loadManifestKey(pemB64)!;
  const h = signAgentRequest(key, "GET", "/api/agent/nodes", SLUG, "");
  const forged: Record<string, string> = { ...h, [HEADER_AGENT_SLUG]: "another-provider" };
  const env = rebuild(forged, "GET", "/api/agent/nodes", "");
  assert.equal(verifyRequest(env, sig(forged), publicKeyBase64), false);
});

test("a tampered method/path fails verification", () => {
  const { publicKeyBase64, pemB64 } = keypair();
  const key = loadManifestKey(pemB64)!;
  const h = signAgentRequest(key, "GET", "/api/agent/nodes", SLUG, "");
  const env = rebuild(h, "POST", "/api/agent/nodes", "");
  assert.equal(verifyRequest(env, sig(h), publicKeyBase64), false);
});

test("a different key does not verify", () => {
  const { pemB64 } = keypair();
  const other = keypair();
  const key = loadManifestKey(pemB64)!;
  const h = signAgentRequest(key, "GET", "/api/agent/nodes", SLUG, "");
  const env = rebuild(h, "GET", "/api/agent/nodes", "");
  assert.equal(verifyRequest(env, sig(h), other.publicKeyBase64), false);
});
