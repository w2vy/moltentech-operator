import type { LoanScanResult } from "./loan-scan";

/**
 * §7 step 5 — the ONE autonomous delete in the whole loan design, and the only place a lender's
 * agent destroys a VM nobody asked it to destroy.
 *
 * ## Why this is its own module
 *
 * > ⚠️ "Step 5 is doing all the safety work. Because the agent originates this delete,
 * > `checkOwnerAuth` is **not** in the path — nothing downstream will catch a bug in loan parsing
 * > that selects the wrong VM. **Scope it narrowly and unit-test it hard.**" — plan §7
 *
 * There is no second party. No hub job, no operator signature, no `ProvisionLog` row, no reviewer.
 * A wrong answer here destroys a node belonging to the BORROWER's paying customer, and the only
 * trace is a log line on the lender's own box. So the decision is a pure function over an already
 * fully-verified `LoanScanResult`, every refusal is named, and the I/O around it does nothing but
 * obey.
 *
 * ## What has already been checked by the time a result gets here
 *
 * `readLoanState` (loan-state.ts) refuses anything that is not: tagged `leased`, signed by the key
 * in the lender's OWN offer, answering an offer revision the lender issued, naming a slot that
 * offer put up, naming **this very VM**, and carrying a hypervisor `ctime` to measure from. The VM
 * itself came from `collectOwnedVms`, which walks `inventory.json` — so it is one this agent
 * manages. Nothing below re-litigates any of that; it decides only whether an already-valid loan
 * has ended and whether the surrounding state is sane enough to act on.
 */

export type ReclaimVerdict =
  | { reclaim: true; expiresAt: Date; borrowerSlug: string }
  | { reclaim: false; reason: ReclaimRefusal };

export type ReclaimRefusal =
  /** Not a loan at all, or a loan whose stamp did not verify. Never a delete candidate. */
  | "not-a-loan"
  /** The term has not run out. The overwhelmingly common answer. */
  | "not-expired"
  /**
   * This borrower holds more of the lender's slots than the offer allows.
   *
   * A breach means a fence UPSTREAM failed — the hub's ingest check, or the offer set itself. The
   * loans are already running, so nothing is gained by racing to tidy up, and something real is
   * lost: an autonomous delete is the most dangerous action in the design and this is exactly the
   * situation where the agent's picture of the world is known to be wrong. Refusing leaves every
   * node running for a human, which is the same direction every other fence in this feature
   * chooses. The cost is a lender's hardware staying occupied until someone looks — deliberate.
   */
  | "concurrency-breach";

/**
 * Decide whether one scanned VM should be reclaimed.
 *
 * `breachedBorrowers` is the output of `overConcurrencyLimit` over the WHOLE scan — passed in
 * rather than recomputed, because the property is about the set and a function given one result
 * could not see it.
 */
export function shouldReclaim(
  result: LoanScanResult,
  breachedBorrowers: ReadonlySet<string>
): ReclaimVerdict {
  if (!result.verdict.loan) return { reclaim: false, reason: "not-a-loan" };

  const { request, expiresAt, expired } = result.verdict;
  const borrowerSlug = request.borrowerSlug;

  // Checked BEFORE expiry so a breach is reported even on loans that are still running — the
  // operator needs to hear about it while there is still time to fix the offer set.
  if (breachedBorrowers.has(borrowerSlug)) {
    return { reclaim: false, reason: "concurrency-breach" };
  }

  if (!expired) return { reclaim: false, reason: "not-expired" };

  return { reclaim: true, expiresAt, borrowerSlug };
}

/**
 * Every reclaim decision for one scan, in one pass — so a test can assert on the WHOLE fleet's
 * outcome rather than one VM at a time.
 *
 * The `breached` set is computed once by the caller and shared, which is the point: a per-VM
 * decision that recomputed it could disagree with itself between two VMs of the same borrower.
 */
export function reclaimPlan(
  results: LoanScanResult[],
  breachedBorrowers: ReadonlySet<string>
): Array<{ result: LoanScanResult; verdict: ReclaimVerdict }> {
  return results.map((result) => ({ result, verdict: shouldReclaim(result, breachedBorrowers) }));
}
