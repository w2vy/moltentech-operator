import { sign, type KeyObject } from "node:crypto";
import { canonicalize, verifyDetached } from "./signing";
import { LoanRequest, SignedLoanRequest, type SignedLoanRequest as SignedLoanRequestType } from "./loan";
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

/** Sign a `LoanRequest` with the borrower's operator key → the record plus its signature. */
export function signLoanRequest(
  request: LoanRequest,
  privateKey: KeyObject
): SignedLoanRequestType {
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
