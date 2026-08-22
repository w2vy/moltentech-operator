import { test } from "node:test";
import assert from "node:assert/strict";
import { manifestOwnerMessage } from "./manifest";
import { ownerAuthMessage } from "./messages";

/**
 * 🔴 Two strings that must survive every rename.
 *
 * The platform is now called Flux Hub, and the operator-facing docs and CLI output say
 * so. These two do NOT, and must not: they are the exact bytes a wallet signs and a
 * verifier re-derives. Renaming either invalidates every signature already produced —
 * proven provider identities, and the owner authorizations that gate delete/move/
 * reprovision — with no error anywhere except a refusal the operator cannot explain.
 *
 * A rename sweep is a find-and-replace, and a find-and-replace does not know that.
 * These tests are the tripwire.
 */

test("🔴 the manifest owner-authorization message keeps its exact wire text", () => {
  const message = manifestOwnerMessage({
    provider: { slug: "acme", name: "Acme" },
    coalitionUrl: "https://coalition-acme.app.runonflux.io",
    pubkey: "PUBKEY",
    ownerAddress: "t1owner",
    hardware: [{ name: "pve-01" }],
    trialDays: 1,
    manualApproval: false,
    serviceFlags: {},
    trustedSelfClaim: false,
    publishedAt: "2026-08-22T00:00:00.000Z",
    signature: "SIG",
  } as never);
  assert.equal(message.split("\n")[0], "MoltenTech provider manifest authorization");
});

test("🔴 the owner-auth job message keeps its exact wire text", () => {
  const first = ownerAuthMessage({
    action: "delete",
    vmName: "mt-187-c4",
    providerSlug: "acme",
    issuedAt: "2026-08-22T00:00:00.000Z",
    nonce: "n",
  } as never).split("\n")[0];
  // Pinned as whatever it is today — the point is that it cannot CHANGE, not what it says.
  assert.equal(first, "MoltenTech owner authorization");
});
