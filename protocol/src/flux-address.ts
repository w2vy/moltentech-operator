import { sha256 } from "@noble/hashes/sha256";
import { base58check } from "@scure/base";
import { z } from "zod";

/**
 * Flux CHAIN addresses — the `t1…` (P2PKH) / `t3…` (P2SH) transparent addresses coins are
 * sent to. Not a ZelID (`1…`, a Bitcoin-versioned login identity) and not an SSP ID: those
 * sign messages, they cannot receive FLUX. Pay-by-Flux pays an operator here, so the
 * distinction is the whole point of this file — the commonest operator mistake is pasting
 * the wallet's LOGIN address.
 *
 * base58check, 2-byte version: 0x1CB8 = t1, 0x1CBD = t3, then a 20-byte hash (22 bytes).
 * Browser-safe (sha256 only, no secp256k1) so the toolkit and the hub's forms can both use it.
 */
const b58c = base58check(sha256);

export type FluxAddressKind = "t1" | "t3";

/** Which kind of Flux chain address this is, or null when it is not one. */
export function fluxAddressKind(value: string): FluxAddressKind | null {
  let payload: Uint8Array;
  try {
    payload = b58c.decode(value.trim());
  } catch {
    return null;
  }
  if (payload.length !== 22) return null;
  const version = ((payload[0] ?? 0) << 8) | (payload[1] ?? 0);
  if (version === 0x1cb8) return "t1";
  if (version === 0x1cbd) return "t3";
  return null;
}

export function isFluxTAddress(value: string): boolean {
  return fluxAddressKind(value) !== null;
}

/** A base58check string that decodes but is NOT a Flux chain address — almost always a ZelID. */
export function looksLikeZelId(value: string): boolean {
  try {
    const p = b58c.decode(value.trim());
    return p.length === 21 && p[0] === 0x00;
  } catch {
    return false;
  }
}

export const FluxTAddress = z.string().refine(isFluxTAddress, "not a Flux t1…/t3… chain address");
