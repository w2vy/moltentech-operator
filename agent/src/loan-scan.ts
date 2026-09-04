import type { LoanOffer } from "@moltentech/protocol";
import { MAX_CONCURRENT_PER_PAIR } from "@moltentech/protocol";
import type { AgentConfig } from "./config";
import { getVmConfig, type OwnedVm } from "./health";
import { LEASED_CHIP, readLoanState, type LoanRefusal, type LoanVerdict } from "./loan-state";

/**
 * The I/O around `readLoanState` — the lender's agent recovering its own loan state each cycle.
 *
 * ⛔ **This module does not delete anything.** §7 step 5's expiry delete is a separate change and
 * a separate review: it is agent-originated, so `checkOwnerAuth` is not in its path and nothing
 * downstream catches a wrong VM. What lands here is the part that can be wrong LOUDLY instead of
 * destructively — the agent reads its own hypervisor, works out which VMs are live loans and
 * which have run out, and says so. An expired loan is reported, logged, and left running.
 *
 * Shape follows `sweepExpiredTrials`: owned VMs only, pure decision + thin I/O, never throws.
 */

/** One VM's loan verdict, with enough context to log or report it. */
export type LoanScanResult = {
  vmName: string;
  nodeName: string;
  verdict: LoanVerdict;
  /** The offer the verdict was reached against, when one matched by revision. */
  offer?: LoanOffer;
};

/**
 * Refusals worth a human's attention.
 *
 * The rest are the ordinary no-op: a VM with no `leased` chip is every VM on a fleet that lends
 * nothing, and logging it would bury the fleet's real signal. These four mean a VM IS advertising
 * itself as leased while its stamp does not hold up — a stamp-builder bug, a tampered
 * description, or an offer the operator deleted out from under a live loan. Each one leaves a
 * borrowed node running with nobody tracking its expiry, which is exactly what a lender wants to
 * hear about.
 */
const LOUD_REFUSALS: ReadonlySet<LoanRefusal> = new Set<LoanRefusal>([
  "bad-signature",
  "stamp-names-another-vm",
  "too-stale",
  "no-ctime",
]);

/**
 * Read every leased VM's stamp and decide what it is.
 *
 * The `leased` chip on the CHEAP listing is the filter: a fleet with no loans makes zero config
 * calls. That ordering is deliberate — the expensive per-VM read happens only for VMs that have
 * already declared themselves.
 *
 * 🔒 Owned VMs only. `vms` comes from `collectOwnedVms`, which walks `inventory.json` and looks
 * each name up in the hypervisor listing, never the reverse — so an operator's own unrelated VM
 * cannot enter this scan whatever it is tagged. Same fence 3 the trial sweep relies on.
 */
export async function scanLoans(
  cfg: AgentConfig,
  vms: OwnedVm[],
  offers: LoanOffer[],
  now: Date,
  // Defaults to the real Proxmox read and is injectable so the whole scan is unit-testable
  // without a hypervisor — the same shape `refreshIsoOnce` uses for `refreshIsoFn`. An ESM
  // namespace object cannot be monkeypatched, so injection is the only version of this that
  // works at all.
  readConfig: typeof getVmConfig = getVmConfig
): Promise<LoanScanResult[]> {
  const results: LoanScanResult[] = [];

  for (const vm of vms) {
    if (!vm.tags.includes(LEASED_CHIP)) continue;
    if (vm.status === "missing") continue; // gone with the VM, and that is correct (§9d.3 rule 2)
    if (vm.vmid === null) continue; // no vmid, no config read — nothing to say about it

    let config: { description?: string; meta?: string };
    try {
      config = await readConfig(cfg, vm.nodeName, vm.vmid);
    } catch (err) {
      // A hypervisor that will not answer is not evidence about a loan. Skip and retry next
      // cycle, exactly as the health pass does for an unreachable node.
      console.error(
        `[loan] ${vm.vmName} on ${vm.nodeName}: config read failed — ${(err as Error).message}`
      );
      continue;
    }

    const description = config.description ?? "";
    const stamp = { ...vm, description, meta: config.meta ?? null };

    // Try every offer this operator holds. A stamp names its offer by revision, and
    // `readLoanState` refuses any offer whose revision it does not name — so at most one can
    // match, and trying them all costs nothing but avoids an index the operator has to keep
    // consistent by hand.
    let matched: LoanScanResult | undefined;
    let lastRefusal: LoanVerdict | undefined;
    for (const offer of offers) {
      const verdict = readLoanState(stamp, offer, now);
      if (verdict.loan) {
        matched = { vmName: vm.vmName, nodeName: vm.nodeName, verdict, offer };
        break;
      }
      // Keep the most INFORMATIVE refusal, not the last one: "unknown-offer-revision" is what
      // every non-matching offer says, and reporting that when one offer actually rejected the
      // signature would hide the real problem.
      if (!lastRefusal || lastRefusal.loan || isLessInformative(lastRefusal.reason, verdict.reason)) {
        lastRefusal = verdict;
      }
    }

    results.push(
      matched ?? {
        vmName: vm.vmName,
        nodeName: vm.nodeName,
        verdict: lastRefusal ?? { loan: false, reason: "unknown-offer-revision" },
      }
    );
  }

  return results;
}

/** `unknown-offer-revision` is the "none of these" answer; anything else says more. */
function isLessInformative(current: LoanRefusal, candidate: LoanRefusal): boolean {
  return current === "unknown-offer-revision" && candidate !== "unknown-offer-revision";
}

/**
 * Log what the scan found, and warn where a lender needs to look.
 *
 * Unconditional on a live loan the way the trial sweep logs unconditionally on a destroy: there
 * is no hub record of the agent's own loan bookkeeping, so this line is the operator's only
 * trace that their hardware is out on loan and when it comes back.
 */
export function logLoanScan(results: LoanScanResult[]): void {
  for (const r of results) {
    if (r.verdict.loan) {
      const { request, provisionedAt, expiresAt, expired } = r.verdict;
      console.log(
        `[loan] ${r.vmName} on ${r.nodeName}: ${expired ? "EXPIRED" : "active"} — ` +
          `borrower=${request.borrowerSlug} offer=rev${request.offerRevision} ` +
          `provisioned=${provisionedAt.toISOString()} expires=${expiresAt.toISOString()}`
      );
      continue;
    }
    if (LOUD_REFUSALS.has(r.verdict.reason)) {
      console.warn(
        `[loan] ${r.vmName} on ${r.nodeName}: leased VM with an unusable stamp ` +
          `(${r.verdict.reason}) — nothing is tracking its expiry`
      );
    }
  }
}

/**
 * §7 step 4's other half — how many of this lender's slots one borrower holds at once.
 *
 * Not in `readLoanState` because it is a property of the SET, not of one VM: a function given a
 * single VM could not check it. Enforced here as well as at the hub's request ingest, neither
 * trusting the other, because a hub that under-counts must not be able to talk this agent into
 * hosting a rack.
 *
 * Reports rather than acts: a breach means the fence upstream failed, and the loans in question
 * are already running. It is the delete path (not built) that must consult this.
 */
export function overConcurrencyLimit(
  results: LoanScanResult[],
  maxConcurrent: number = MAX_CONCURRENT_PER_PAIR
): Array<{ borrowerSlug: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of results) {
    if (!r.verdict.loan) continue;
    const slug = r.verdict.request.borrowerSlug;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > maxConcurrent)
    .map(([borrowerSlug, count]) => ({ borrowerSlug, count }));
}
