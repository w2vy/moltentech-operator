import type { LoanOffer, SignedLoanRequest } from "@moltentech/protocol";
import { MAX_LOAN_DURATION_HOURS } from "@moltentech/protocol";
import { verifyLoanStamp } from "@moltentech/protocol/loan-signing";

/**
 * prudent-lending-lamport §9d.3 — the borrowed VM's own Proxmox config IS this agent's loan state.
 *
 * The agent has no writable volume (`docker-compose.operator.yml` mounts none) and re-reads
 * `inventory.json` every cycle precisely so nothing is remembered. So after a restart it cannot
 * recall which VM it created under which loan, for whom, or when — and §7 step 5 ("the VM I am
 * about to delete is one *I* provisioned under this loan") needs all three.
 *
 * The store is the VM itself: the verbatim signed `LoanRequest` in its `description`, and the
 * hypervisor's own `ctime` for the clock. Both are local facts. **MT is not on this path at all**,
 * which is the whole point — the rejected alternative (round-trip the record through the hub) let
 * MT serve back an older record and pull an expiry IN, deleting the borrower's paying customer's
 * node early. §5's "stale records are safe" argument only ever covered the other direction.
 *
 * ## What this module is NOT
 *
 * ⛔ It never writes, never calls Proxmox, and never deletes. It is the pure decision, in the
 * spirit of `trial-expiry.ts` — because §7 warns that the expiry delete is agent-originated, so
 * `checkOwnerAuth` is not in the path and **nothing downstream catches a bug in loan parsing that
 * selects the wrong VM**. Everything that could pick a VM is here, where a test can reach it
 * without a hypervisor.
 */

/** The chip the hub stamps on a loaned VM. Cheap filter: only these VMs need a config read. */
export const LOANED_CHIP = "loaned";

/**
 * Fence — an expiry further in the past than this reads as BROKEN, not as overdue.
 *
 * Same reasoning as `trial-expiry.MAX_OVERDUE_MS`, and the stakes are higher: this VM belongs to
 * the borrower's PAYING customer. A restored backup, a rewound host clock or a mis-parsed `ctime`
 * all produce a wildly stale expiry, and none of them is a loan anyone is waiting to reclaim.
 * Refusing leaves the VM running for a human to look at, which is the safe direction.
 *
 * The window is deliberately generous relative to the 72h cap: anything past it is not a late
 * loan, it is a broken read.
 */
export const MAX_OVERDUE_MS = 7 * 24 * 60 * 60 * 1000;

/** `meta: creation-qemu=8.1.5,ctime=1708264093` — the hypervisor's own record of VM creation. */
const CTIME_RE = /(?:^|,)ctime=(\d+)(?:,|$)/;

/**
 * Parse `ctime` out of a Proxmox `meta` line.
 *
 * ⚠️ The key is `ctime`, NOT `creation` — the plan's first draft had it wrong and it was corrected
 * only by reading a live config on pve55. Seconds since the epoch, not milliseconds.
 *
 * Returns null for anything else, including a `meta` line that exists but carries no `ctime`
 * (older VMs predate the field), because "no clock" must not silently become "epoch zero".
 */
export function parseCtime(meta?: string | null): Date | null {
  if (!meta) return null;
  const m = CTIME_RE.exec(meta);
  if (!m) return null;
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/** What the agent reads off one VM before deciding anything. */
export type VmStamp = {
  vmName: string;
  nodeName: string;
  /** Chips from the cheap `GET /nodes/{node}/qemu` listing. */
  tags: string[];
  /** `description` from `GET /nodes/{node}/qemu/{vmid}/config`. */
  description: string;
  /** `meta` from the same config read. */
  meta?: string | null;
};

export type LoanVerdict =
  | {
      loan: true;
      request: SignedLoanRequest;
      /** The agent's OWN observation (§5) — the hypervisor's clock, never the record's. */
      provisionedAt: Date;
      expiresAt: Date;
      /** True once `expiresAt` has passed and the read is not stale enough to be suspect. */
      expired: boolean;
    }
  | { loan: false; reason: LoanRefusal };

export type LoanRefusal =
  /** No `loaned` chip — not a loaned VM, and the description was not even read. */
  | "not-loaned"
  /** The stamp is absent, unparseable, malformed, or not signed by the offer's borrower. */
  | "no-record"
  | "not-json"
  | "schema"
  | "bad-signature"
  /** The stamp is valid but does not answer an offer this lender issued (§7 steps 1 and 3). */
  | "wrong-lender"
  | "wrong-borrower"
  | "unknown-offer-revision"
  /** The stamp names a slot this offer never put up, or a DIFFERENT VM than the one read. */
  | "slot-not-offered"
  | "stamp-names-another-vm"
  /** The hypervisor gave no usable creation time, so there is no clock to judge against. */
  | "no-ctime"
  /** Past expiry by more than `MAX_OVERDUE_MS` — reads as broken, not as overdue. */
  | "too-stale";

/**
 * Decide, from one VM's own state plus the lender's own offer, whether it is a live loan.
 *
 * §7's checklist, in order, with every step that could select the wrong VM made explicit:
 *
 * 1. **`loaned` chip present.** Two independent markers must agree before anything downstream
 *    considers a delete — exactly the rule `trial-expiry` follows for `free` + `until-`.
 * 2. **Signature checks against `offer.borrowerPubkey`** — the lender's own belief about the
 *    borrower's key, never a key carried by the record itself.
 * 3. **`offerRevision` matches an offer this lender actually issued**, and the slugs on the
 *    record match the offer's.
 * 4. **The borrowed slot is in `offer.slots`** — and, the fence that has no counterpart in the
 *    plan's prose, **the stamp names THIS VM**. A stamp copied onto another VM must not
 *    authorize touching it; without this check the record's authenticity would be mistaken for
 *    a statement about the VM it happens to sit on.
 * 5. **Expiry** = `ctime + min(request duration, offer.maxDurationHours)`, so replaying any
 *    record can only ever produce a loan the lender already signed for.
 *
 * `maxConcurrent` (§7 step 4's count) is NOT here: it is a property of the set of loaned VMs, not
 * of one of them, so it belongs to the caller that holds the whole list. A function given one VM
 * could not check it even if it wanted to.
 */
export function readLoanState(
  vm: VmStamp,
  offer: LoanOffer,
  now: Date,
  opts: { maxOverdueMs?: number } = {}
): LoanVerdict {
  const maxOverdueMs = opts.maxOverdueMs ?? MAX_OVERDUE_MS;

  if (!vm.tags.includes(LOANED_CHIP)) return { loan: false, reason: "not-loaned" };

  const stamp = verifyLoanStamp(vm.description, offer.borrowerPubkey);
  if (!stamp.ok) return { loan: false, reason: stamp.reason };
  const request = stamp.request;

  if (request.lenderSlug !== offer.lenderSlug) return { loan: false, reason: "wrong-lender" };
  if (request.borrowerSlug !== offer.borrowerSlug) return { loan: false, reason: "wrong-borrower" };
  if (request.offerRevision !== offer.revision) {
    return { loan: false, reason: "unknown-offer-revision" };
  }

  // v1 is single-shot: the schema pins `borrows` to exactly one entry. The guard is not
  // redundant — zod's `.length(1)` validates but does not narrow to a tuple, and at a delete site
  // an assertion that "cannot" fire is a worse thing to write than a refusal that never does.
  const borrow = request.borrows[0];
  if (!borrow) return { loan: false, reason: "schema" };
  if (borrow.vmName !== vm.vmName || borrow.nodeName !== vm.nodeName) {
    return { loan: false, reason: "stamp-names-another-vm" };
  }
  const offered = offer.slots.some(
    (s) => s.vmName === borrow.vmName && s.nodeName === borrow.nodeName
  );
  if (!offered) return { loan: false, reason: "slot-not-offered" };

  const provisionedAt = parseCtime(vm.meta);
  if (!provisionedAt) return { loan: false, reason: "no-ctime" };

  const hours = Math.min(
    borrow.durationHours,
    offer.maxDurationHours,
    MAX_LOAN_DURATION_HOURS
  );
  const expiresAt = new Date(provisionedAt.getTime() + hours * 60 * 60 * 1000);

  const overdueMs = now.getTime() - expiresAt.getTime();
  if (overdueMs > maxOverdueMs) return { loan: false, reason: "too-stale" };

  return { loan: true, request, provisionedAt, expiresAt, expired: overdueMs > 0 };
}

/**
 * Rule 1 of §9d.3 — a re-stamp must be MONOTONIC.
 *
 * A reprovision during a loan recreates the VM and the stamp dies with it, so the stamp has to be
 * re-writable — and the re-write path is exactly where a rewind could sneak back in. A later
 * stamp is accepted only if it describes the SAME loan and does not pull the expiry in.
 *
 * Later is allowed: a reprovision resets `ctime`, so an honest re-stamp of the same record
 * legitimately produces a later expiry (the loan effectively restarts). That direction can only
 * ever cost the lender time they already signed away, which §5 established is the safe one.
 */
export function acceptsRestamp(
  established: { request: SignedLoanRequest; expiresAt: Date },
  incoming: { request: SignedLoanRequest; expiresAt: Date }
): boolean {
  const a = established.request;
  const b = incoming.request;
  const slotA = a.borrows[0];
  const slotB = b.borrows[0];
  if (!slotA || !slotB) return false;
  const sameLoan =
    a.nonce === b.nonce &&
    a.borrowerSlug === b.borrowerSlug &&
    a.lenderSlug === b.lenderSlug &&
    a.offerRevision === b.offerRevision &&
    slotA.vmName === slotB.vmName &&
    slotA.nodeName === slotB.nodeName;
  if (!sameLoan) return false;
  return incoming.expiresAt.getTime() >= established.expiresAt.getTime();
}
