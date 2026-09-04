import { z } from "zod";
import { Envelope, NoCtrl, ProviderSlug, TierKey, Timestamp } from "./common";

/**
 * Node loans — the signed records (`prudent-lending-lamport` §4).
 *
 * v1 scope is §0: a bounded loan between two operators who have already talked to each other.
 * Only `LoanRequest` is load-bearing for the agent's durable state (§9d.3) — it is the record
 * stamped verbatim into the borrowed VM's Proxmox config — but `LoanOffer` is defined here
 * alongside it because the agent verifies a request AGAINST its own offer, and a request schema
 * with no ceiling to check it against is only half a contract.
 */

/** Hours, whole, and never longer than the platform's hard cap. */
export const DurationHours = z.number().int().positive().max(72);

/**
 * The platform ceiling on a single loan (§0.1). Config constant, not a wire value: a longer
 * request is refused rather than clamped, so the two sides never disagree about what was agreed.
 */
export const MAX_LOAN_DURATION_HOURS = 72;

/**
 * How many of one lender's slots a single borrower may hold at once (§0.2 item 4).
 *
 * 📌 v1 value is 1 and it is DELIBERATE — a borrower takes one box, not the rack. The ceiling
 * above it is not load-bearing and is expected to be tuned, so nothing may branch on the number.
 * Enforced in BOTH places, neither trusting the other: the hub at request ingest, the lender's
 * agent at verify time (§7 step 4).
 */
export const MAX_CONCURRENT_PER_PAIR = 1;
export const MAX_CONCURRENT_CEILING = 2;

/**
 * No new loan of the same (lender, borrower, slot) within this long of a return (§0.2 item 6).
 *
 * 📌 24h is ARBITRARY and TUNABLE. Only its EXISTENCE is load-bearing — it is what stops serial
 * re-borrowing from rebuilding the permanent loan this design exists to prevent.
 */
export const LOAN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** One of the lender's slots, named the way both sides can address it on a hypervisor. */
export const LoanSlotRef = z.object({
  vmName: NoCtrl.min(1).max(64),
  nodeName: NoCtrl.min(1).max(64),
});
export type LoanSlotRef = z.infer<typeof LoanSlotRef>;

/**
 * `LoanOffer` — signed by the LENDER's agent key (§4.1).
 *
 * The offer is bound to one `borrowerSlug`: open/bearer offers stay out of v1 (§0.2 item 7).
 */
export const LoanOffer = Envelope.extend({
  revision: z.number().int().positive(),
  lenderSlug: ProviderSlug,
  borrowerSlug: ProviderSlug,
  /** The borrower's operator key, as the LENDER believes it — self-pinned at contract time. */
  borrowerPubkey: z.string().min(1),
  slots: z.array(LoanSlotRef.extend({ tier: TierKey })).min(1),
  /** The ceiling. Nothing downstream may exceed it; `expiry` takes a `min()` against it. */
  maxDurationHours: DurationHours,
  maxConcurrent: z.number().int().positive().max(MAX_CONCURRENT_CEILING),
  /** How long the OFFER stands. Not the loan length — a live offer is not a live loan. */
  offerExpiresAt: Timestamp,
  issuedAt: Timestamp,
  nonce: z.string().min(1),
});
export type LoanOffer = z.infer<typeof LoanOffer>;

/**
 * `LoanRequest` — signed by the BORROWER's operator key (§4.2).
 *
 * 🔻 v1 is SINGLE-SHOT (§0.2 item 3): one request = one slot, one duration. `revision` stays in
 * the struct for forward compatibility and v1 refuses anything but the first; amending means a
 * new request against the offer. With early return cut, nothing is left for revision
 * reconciliation to order.
 *
 * ⚠️ `nonce` does NOT mean what it means in `OwnerAuth` (§4.4). This is a STANDING record,
 * re-read from the VM config every cycle — burning the nonce would kill the loan on the second
 * read. `revision` does the ordering; the nonce only adds uniqueness to the signed bytes.
 */
export const LoanRequest = Envelope.extend({
  revision: z.literal(1),
  borrowerSlug: ProviderSlug,
  lenderSlug: ProviderSlug,
  /** Which offer this answers — binds the request to that offer's ceiling. */
  offerRevision: z.number().int().positive(),
  borrows: z.array(LoanSlotRef.extend({ durationHours: DurationHours })).length(1),
  issuedAt: Timestamp,
  nonce: z.string().min(1),
});
export type LoanRequest = z.infer<typeof LoanRequest>;

/** The lifecycle a loan is reported in. `expired` is observed; `reclaimed` is done. */
export const LoanState = z.enum(["offered", "active", "expired", "reclaimed"]);
export type LoanState = z.infer<typeof LoanState>;

/**
 * `LoanStatus` — signed by the LENDER's agent key (§4.3).
 *
 * How MT learns a reclaim happened: the expiry delete is agent-originated and never passes
 * through a `ProvisionLog` row, so without this the hub would only ever infer it from absence.
 */
export const LoanStatus = Envelope.extend({
  lenderSlug: ProviderSlug,
  reportedAt: Timestamp,
  loans: z.array(
    LoanSlotRef.extend({
      borrowerSlug: ProviderSlug,
      /** Which request this honors. */
      requestRevision: z.number().int().positive(),
      /** The agent's OWN observation, never a borrower-supplied timestamp (§5). */
      provisionedAt: Timestamp,
      expiresAt: Timestamp,
      vmRunning: z.boolean(),
      state: LoanState,
    })
  ),
  nonce: z.string().min(1),
});
export type LoanStatus = z.infer<typeof LoanStatus>;

/**
 * A signed record as it sits in the VM description: the envelope plus a detached signature.
 *
 * The signature covers `canonicalize(record)` — the record with `signature` REMOVED — so the
 * verifier re-derives exactly what the signer produced. Same convention as the manifest and the
 * request envelope; see `protocol/src/signing.ts`.
 */
export const SignedLoanRequest = LoanRequest.extend({ signature: z.string().min(1) });
export type SignedLoanRequest = z.infer<typeof SignedLoanRequest>;
