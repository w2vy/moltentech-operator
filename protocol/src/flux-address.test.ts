import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha256";
import { base58check } from "@scure/base";
import { FluxTAddress, fluxAddressKind, isFluxTAddress, looksLikeZelId } from "./flux-address";

// Real chain addresses (Flux foundation payment address; a P2SH collateral address).
const T1 = "t1d1FRcLh5nrF7ubbTzwV7KiqvA8bXKED8e";
// A Bitcoin-versioned (0x00 + 20 bytes) login identity, NOT a chain address — built rather than
// pasted so the checksum is right by construction.
const ZELID = base58check(sha256).encode(Uint8Array.from([0, ...Array.from({ length: 20 }, (_, i) => i + 1)]));
// P2SH version 0x1CBD + 20 bytes.
const T3 = base58check(sha256).encode(Uint8Array.from([0x1c, 0xbd, ...Array.from({ length: 20 }, (_, i) => 40 - i)]));

test("t1 is a Flux chain address; a ZelID is not", () => {
  assert.equal(fluxAddressKind(T1), "t1");
  assert.equal(fluxAddressKind(T3), "t3");
  assert.equal(T3.startsWith("t3"), true);
  assert.equal(isFluxTAddress(` ${T1} `), true, "whitespace tolerated");
  assert.equal(isFluxTAddress(ZELID), false);
  assert.equal(isFluxTAddress("t1d1FRcLh5nrF7ubbTzwV7KiqvA8bXKED8f"), false, "bad checksum");
  assert.equal(isFluxTAddress(""), false);
  assert.equal(isFluxTAddress("not-an-address"), false);
});

test("looksLikeZelId names the commonest mistake", () => {
  assert.equal(looksLikeZelId(ZELID), true);
  assert.equal(looksLikeZelId(T1), false);
  assert.equal(looksLikeZelId("garbage"), false);
});

test("FluxTAddress zod refinement", () => {
  assert.equal(FluxTAddress.safeParse(T1).success, true);
  assert.equal(FluxTAddress.safeParse(ZELID).success, false);
});
