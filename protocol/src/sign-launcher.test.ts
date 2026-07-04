import { test } from "node:test";
import assert from "node:assert/strict";
import { signFluxMessage, verifyOwnerAuth } from "./wallet";
import { ownerAuthMessage, type OwnerAuthClaim } from "./messages";
import {
  assembleOwnerAuth,
  buildOwnerAuthSignLauncher,
  buildSignLauncherHtml,
  buildZelcoreSignLink,
} from "./sign-launcher";

// Deterministic owner key (valid: 1 < k < n) — stands in for the wallet.
const PRIV = new Uint8Array(32).fill(0x11);

const CLAIM: OwnerAuthClaim = {
  action: "delete",
  providerSlug: "shadow-b",
  vmName: "mt-shadow-b-n1",
  nodeName: "pve50",
  nonce: "2e1f1e18f0cd1caf744bf2beba73dd1c",
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
};

test("buildOwnerAuthSignLauncher signs the canonical owner-auth message", () => {
  const { message, zelcoreLink, html } = buildOwnerAuthSignLauncher(CLAIM);
  // The page must sign EXACTLY what the operator verifier reconstructs.
  assert.equal(message, ownerAuthMessage(CLAIM));
  assert.ok(zelcoreLink.startsWith("zel:?action=sign"));
  assert.ok(zelcoreLink.includes(encodeURIComponent(message)));
  // The launcher offers both wallets and embeds the exact message.
  assert.ok(html.includes("sspwid_sign_message"));
  assert.ok(html.includes('href="zel:?action=sign'));
  assert.ok(html.includes(message)); // raw message in the <pre> (no chars need escaping)
});

test("assembleOwnerAuth round-trips: launcher message -> wallet sig -> verifyOwnerAuth", () => {
  const { message } = buildOwnerAuthSignLauncher(CLAIM);
  // Simulate SSP/Zelcore returning {address, signature} for the message.
  const { address, signature } = signFluxMessage(PRIV, message, { type: "zelid" });

  const auth = assembleOwnerAuth(CLAIM, signature);
  assert.equal(auth.signature, signature);
  // Verifies for the signer's pinned owner address...
  assert.deepEqual(verifyOwnerAuth(auth, address), { ok: true });
  // ...and is refused for any other pinned owner.
  assert.equal(verifyOwnerAuth(auth, "1BoatSLRHtKNngkdXEeobR76b53LETtpyT").ok, false);
});

test("assembleOwnerAuth rejects a malformed (empty) signature", () => {
  assert.throws(() => assembleOwnerAuth(CLAIM, ""));
});

test("buildZelcoreSignLink encodes an optional callback", () => {
  const link = buildZelcoreSignLink({
    message: "hello",
    callback: "https://console.example/authz/cb?id=1",
  });
  assert.ok(link.includes("action=sign"));
  assert.ok(link.includes("message=hello"));
  assert.ok(
    link.includes(
      `callback=${encodeURIComponent("https://console.example/authz/cb?id=1")}`
    )
  );
});

test("buildSignLauncherHtml escapes the Zelcore link in the href attribute", () => {
  // The link's '&' separators must be entity-escaped inside the HTML attribute.
  const html = buildSignLauncherHtml({
    message: "m",
    zelcoreLink: "zel:?action=sign&message=m&icon=x",
  });
  assert.ok(html.includes("action=sign&amp;message=m&amp;icon=x"));
});
