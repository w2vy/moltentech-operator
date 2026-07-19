import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateEd25519, signManifestBody } from "./signing";
import { signFluxMessage } from "./wallet";
import { manifestOwnerMessage, type ProviderManifest } from "./manifest";

// `mt-manifest verify` is the command an operator reaches for when they suspect a
// bad manifest, so a false FAILED sends them re-signing a manifest that was fine.
// It once passed the raw payload straight to verifyManifestObject, which could only
// fail on an 'authorize' wrapper (no top-level `signature`). These drive the real
// CLI end to end — a shape assertion would not have caught that.

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mt-verify-"));

/** Deterministic secp256k1 owner key (valid: 1 < k < n), as in wallet.test.ts. */
const OWNER_PRIV = new Uint8Array(32).fill(0x22);

function buildManifest(): { manifest: ProviderManifest; ownerAddress: string } {
  const { publicKeyBase64, privateKey } = generateEd25519();
  const { address } = signFluxMessage(OWNER_PRIV, "probe");
  const body = {
    schemaVersion: 2,
    provider: { slug: "verify-test", name: "Verify Test" },
    coalitionUrl: "https://coalition-verify-test.example/",
    hardware: [{ name: "pve-01" }],
    trialDays: 7,
    manualApproval: false,
    serviceFlags: {},
    trustedSelfClaim: false,
    ownerAddress: address,
    pubkey: publicKeyBase64,
    publishedAt: new Date().toISOString(),
  };
  return {
    manifest: { ...body, signature: signManifestBody(body, privateKey) } as ProviderManifest,
    ownerAddress: address,
  };
}

/** Run the CLI, returning stdout + exit code rather than throwing on failure. */
function verify(payload: unknown, name: string): { out: string; code: number } {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(payload));
  try {
    const out = execFileSync("npx", ["tsx", CLI, "verify", "--in", path], { encoding: "utf8" });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { out: err.stdout ?? "", code: err.status ?? 1 };
  }
}

test("verify accepts a bare manifest", () => {
  const { manifest } = buildManifest();
  const { out, code } = verify(manifest, "bare");
  assert.equal(code, 0);
  assert.match(out, /^OK/m);
});

test("verify accepts an owner-signed wrapper and reports the owner", () => {
  const { manifest, ownerAddress } = buildManifest();
  const { signature } = signFluxMessage(OWNER_PRIV, manifestOwnerMessage(manifest));
  const { out, code } = verify({ manifest, ownerSignature: signature }, "wrapper");
  assert.equal(code, 0, "a valid wrapper must not report FAILED — the original bug");
  assert.match(out, /^OK/m);
  assert.match(out, new RegExp(ownerAddress));
});

test("verify rejects a wrapper whose owner signature is from the wrong wallet", () => {
  const { manifest } = buildManifest();
  // Same message, different wallet: the ed25519 body is untouched and still valid,
  // so only the owner check can catch this.
  const { signature } = signFluxMessage(
    new Uint8Array(32).fill(0x33),
    manifestOwnerMessage(manifest)
  );
  const { out, code } = verify({ manifest, ownerSignature: signature }, "wrong-owner");
  assert.equal(code, 1);
  assert.match(out, /owner wallet signature does not verify/);
});

test("verify rejects a tampered body under a valid-looking wrapper", () => {
  const { manifest } = buildManifest();
  const { signature } = signFluxMessage(OWNER_PRIV, manifestOwnerMessage(manifest));
  const tampered = { ...manifest, hardware: [{ name: "pve-99" }] };
  const { out, code } = verify({ manifest: tampered, ownerSignature: signature }, "tampered");
  assert.equal(code, 1);
  assert.match(out, /manifest signature invalid/);
});
