import { SCHEMA_VERSION } from "./common";
import {
  MAX_LOAN_DURATION_HOURS,
  type LoanRequest,
  type SignedLoanOffer,
} from "./loan";
import { verifySignedLoanOffer } from "./loan-signing";

/**
 * The BORROWER's half of the handshake — `prudent-lending-lamport` §0.4 step 4.
 *
 * A lender hands over a signed `LoanOffer` (out of band in v1: two operators who have already
 * talked to each other). This turns it into a `LoanRequest` the borrower's operator key can sign,
 * or refuses with a reason the operator can act on.
 *
 * ## Why the checks are here and not only at the lender
 *
 * The lender's agent verifies everything again before it provisions (§7), so nothing here is
 * load-bearing for the lender's safety. It is load-bearing for the BORROWER: without it the
 * failure mode is a request that is silently ignored on someone else's hardware, with no error
 * anywhere the borrower can see. Every refusal below is a mistake the borrower can only diagnose
 * on their own side.
 *
 * ⛔ Pure. No key handling, no file I/O, no network.
 */

export type AcceptRefusal =
  /** The blob is not a signed offer at all. */
  | "not-an-offer"
  /** It does not verify against the lender's key — wrong key, or tampered in transit. */
  | "bad-lender-signature"
  /** The offer names a different borrower. It was not meant for this operator. */
  | "not-my-offer"
  /**
   * The offer names a DIFFERENT key for this borrower than the one about to sign.
   *
   * The sharpest check here. The lender will verify the request against `offer.borrowerPubkey`,
   * so signing with any other key produces a request that fails verification on hardware the
   * borrower cannot see, with the refusal logged only in the lender's agent. Catching it at
   * signing time turns a silent remote failure into a local one.
   */
  | "offer-names-another-key"
  /** The offer's own window has closed — a lender is not obliged to honour a stale offer. */
  | "offer-window-closed"
  /** The requested slot is not one the offer put up. */
  | "slot-not-offered"
  /** The requested duration exceeds the offer's ceiling (or the platform's 72h cap). */
  | "duration-over-ceiling";

export type AcceptVerdict =
  | { ok: true; request: LoanRequest; offer: SignedLoanOffer }
  | { ok: false; reason: AcceptRefusal };

/**
 * Build the `LoanRequest` that answers an offer, checking every term first.
 *
 * `issuedAt` is passed in rather than stamped from the clock so the result is deterministic and
 * a borrower can reproduce the exact bytes they signed — the same rule the offer builder follows.
 * The nonce is derived from the content by the signer, for the same reason (§4.4: it exists only
 * to add uniqueness to the signed bytes, and churn costs more than randomness buys).
 *
 * v1 is single-shot (§0.2 item 3): one request, one slot, one duration. `revision` is fixed at 1
 * and amending means a new request against the offer.
 */
export function acceptOffer(
  rawOffer: unknown,
  lenderPubkey: string,
  me: { slug: string; pubkey: string },
  want: { vmName: string; nodeName: string; durationHours: number },
  issuedAt: Date,
  now: Date
): AcceptVerdict {
  const verified = verifySignedLoanOffer(rawOffer, lenderPubkey);
  if (!verified.ok) {
    return {
      ok: false,
      reason: verified.reason === "bad-signature" ? "bad-lender-signature" : "not-an-offer",
    };
  }
  const offer = verified.offer;

  if (offer.borrowerSlug !== me.slug) return { ok: false, reason: "not-my-offer" };
  if (offer.borrowerPubkey !== me.pubkey) return { ok: false, reason: "offer-names-another-key" };

  if (new Date(offer.offerExpiresAt).getTime() <= now.getTime()) {
    return { ok: false, reason: "offer-window-closed" };
  }

  const offered = offer.slots.some(
    (s) => s.vmName === want.vmName && s.nodeName === want.nodeName
  );
  if (!offered) return { ok: false, reason: "slot-not-offered" };

  // Refused, never clamped: a borrower who asked for 48h and silently got 24h would plan around
  // a term nobody agreed to. Both sides must mean the same thing by the number they signed.
  if (
    want.durationHours > offer.maxDurationHours ||
    want.durationHours > MAX_LOAN_DURATION_HOURS
  ) {
    return { ok: false, reason: "duration-over-ceiling" };
  }

  return {
    ok: true,
    offer,
    request: {
      schemaVersion: SCHEMA_VERSION,
      revision: 1,
      borrowerSlug: me.slug,
      lenderSlug: offer.lenderSlug,
      offerRevision: offer.revision,
      borrows: [
        { vmName: want.vmName, nodeName: want.nodeName, durationHours: want.durationHours },
      ],
      issuedAt: issuedAt.toISOString(),
      // Replaced by the signer with a content-derived value; a placeholder keeps the type honest.
      nonce: "unsigned",
    },
  };
}
