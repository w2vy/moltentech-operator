import { createHash, sign, type KeyObject } from "node:crypto";
import { canonicalize, verifyDetached } from "./signing";
import {
  LoanRequest,
  SignedLoanOffer,
  SignedLoanRequest,
  type LoanOffer as LoanOfferType,
  type SignedLoanOffer as SignedLoanOfferType,
  type SignedLoanRequest as SignedLoanRequestType,
} from "./loan";
import { splitSignedRecord, stripTrailingNewlines } from "./signed-record";

/**
 * Signing and verification for the loan records — server-only (`node:crypto`), so import from
 * "@moltentech/protocol/loan-signing", never from the package root.
 *
 * The verifier here is the one the lender's agent runs against a stamp it reads back off a
 * hypervisor, with no hub in the path (`prudent-lending-lamport` §9d.3). Everything it needs to
 * decide is in the bytes it just read.
 */

/**
 * The exact bytes a `LoanRequest` signature covers: canonical JSON of the record with
 * `signature` removed.
 *
 * Not `JSON.stringify` of the object as received — key order off the wire is not stable, and the
 * whole point of `canonicalize` is that signer and verifier derive the same string from
 * differently-ordered objects.
 */
export function loanRequestSigningBytes(record: Record<string, unknown>): string {
  const { signature: _signature, ...body } = record;
  return canonicalize(body);
}

/**
 * A DETERMINISTIC nonce for a request, derived from its own content — same rule as the offer's.
 *
 * §4.4: the nonce is never burned here (the record is standing, re-read from a VM config every
 * cycle), so its only job is uniqueness in the signed bytes. Content-derived also makes
 * `acceptsRestamp`'s "is this the same loan" test content-based rather than dependent on a random
 * value the agent would have no way to recover after a restart.
 */
export function loanRequestNonce(body: Record<string, unknown>): string {
  const { nonce: _nonce, signature: _signature, ...rest } = body;
  return createHash("sha256").update(canonicalize(rest), "utf8").digest("hex").slice(0, 32);
}

/**
 * Sign a `LoanRequest` with the borrower's operator key → the record plus its signature.
 *
 * The nonce on the way in is ignored and replaced with the content-derived one, so a caller
 * cannot accidentally ship a placeholder and two signings of the same request agree byte for
 * byte.
 */
export function signLoanRequest(
  request: LoanRequest,
  privateKey: KeyObject
): SignedLoanRequestType {
  const withNonce = { ...request, nonce: "" };
  request = { ...request, nonce: loanRequestNonce(withNonce as unknown as Record<string, unknown>) };
  const signature = sign(
    null,
    Buffer.from(loanRequestSigningBytes(request as unknown as Record<string, unknown>), "utf8"),
    privateKey
  ).toString("base64");
  return { ...request, signature };
}

/**
 * Why a failure is reported as a REASON rather than a boolean.
 *
 * The lender's agent uses this to decide whether to delete a VM, and §7's warning is that step 5
 * is doing all the safety work with `checkOwnerAuth` out of the path — nothing downstream catches
 * a bug in loan parsing that selects the wrong VM. A bare `false` at a delete site is unloggable
 * and untestable; every distinct way a stamp can fail gets its own name so a refusal says why.
 */
export type LoanStampVerdict =
  | { ok: true; request: SignedLoanRequestType }
  | {
      ok: false;
      reason:
        | "no-record" // no `--- signed ---` section at all
        | "not-json" // the section is not a JSON object
        | "schema" // it parses but is not a LoanRequest (wrong revision, >1 borrow, …)
        | "bad-signature"; // it is a LoanRequest and the signature does not check out
    };

/**
 * Read and verify a `LoanRequest` stamped into a VM's Proxmox `description`.
 *
 * `borrowerPubkey` comes from the lender's OWN offer, never from the record — a record that
 * carried its own key would prove nothing but that its author owned a key.
 *
 * ⚠️ The record is verified against the bytes AS READ. The trailing-newline normalisation is in
 * `splitSignedRecord`, shared with the writer, so what is hashed here is what survives a Proxmox
 * round trip and nothing else. Do not `trim()` — leading and interior whitespace survive the
 * round trip and are part of the signed bytes.
 */
export function verifyLoanStamp(description: string, borrowerPubkey: string): LoanStampVerdict {
  const { record } = splitSignedRecord(description);
  if (record === null || record === "") return { ok: false, reason: "no-record" };

  let raw: unknown;
  try {
    raw = JSON.parse(record);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "not-json" };
  }

  const parsed = SignedLoanRequest.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "schema" };

  const bytes = loanRequestSigningBytes(raw as Record<string, unknown>);
  if (!verifyDetached(bytes, parsed.data.signature, borrowerPubkey)) {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true, request: parsed.data };
}

/** The record as it is written into the description: canonical, one line, no trailing newline. */
export function loanStampRecord(signed: SignedLoanRequestType): string {
  return stripTrailingNewlines(canonicalize(signed));
}


/**
 * The `LoanOffer` signing bytes: canonical JSON with `signature` removed. Same rule as the
 * request — a shared helper rather than two call sites that must remember the same convention.
 */
export function loanOfferSigningBytes(record: Record<string, unknown>): string {
  const { signature: _signature, ...body } = record;
  return canonicalize(body);
}

/**
 * A DETERMINISTIC nonce, derived from the offer's own content.
 *
 * §4.4: unlike `OwnerAuth`, these are standing records — the nonce is never burned, and its only
 * job is to add uniqueness to the signed bytes. A random one would do that too, but it would make
 * the agent emit a different signed blob on every cycle for an unchanged offer: the operator's
 * copy, the borrower's copy and the hub's copy would all drift apart with nothing having changed.
 *
 * Content-derived gives the uniqueness without the churn. Two genuinely different offers differ
 * in at least one field and so get different nonces; the same offer is byte-stable forever.
 */
export function loanOfferNonce(body: Record<string, unknown>): string {
  const { nonce: _nonce, signature: _signature, ...rest } = body;
  return createHash("sha256").update(canonicalize(rest), "utf8").digest("hex").slice(0, 32);
}

/** Sign a `LoanOffer` with the LENDER's agent key. */
export function signLoanOffer(offer: LoanOfferType, privateKey: KeyObject): SignedLoanOfferType {
  const signature = sign(
    null,
    Buffer.from(loanOfferSigningBytes(offer as unknown as Record<string, unknown>), "utf8"),
    privateKey
  ).toString("base64");
  return { ...offer, signature };
}

export type LoanOfferVerdict =
  | { ok: true; offer: SignedLoanOfferType }
  | { ok: false; reason: "not-json" | "schema" | "bad-signature" };

/**
 * Verify a signed offer against the LENDER's agent pubkey.
 *
 * This is the borrower's side of the handshake, and the hub's if it ever relays one: neither
 * authored the offer, so neither may take its word for it. A lender's own agent does NOT need
 * this — it reads its offers from a local file it wrote (§7 step 1).
 */
export function verifySignedLoanOffer(raw: unknown, lenderPubkey: string): LoanOfferVerdict {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "not-json" };
  }
  const parsed = SignedLoanOffer.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "schema" };
  const bytes = loanOfferSigningBytes(raw as Record<string, unknown>);
  if (!verifyDetached(bytes, parsed.data.signature, lenderPubkey)) {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true, offer: parsed.data };
}
