/**
 * brisk-expiring-liskov — a free trial's VM ends ITSELF, on this agent, with no hub in the loop.
 *
 * The hub stamps a trial VM `flux-hub;free;<tier>;until-YYYY-MM-DD` at create. This agent already
 * lists every owned VM once a cycle for the health report, and that listing already carries
 * `tags` — so the deadline is readable for free. When it has passed, the agent deprovisions the
 * VM itself. No job is claimed, no signature is requested, `checkOwnerAuth` is never entered, and
 * the hub is told nothing it does not find out on its own (the VM simply reports `missing`).
 *
 * ## Why a tag may gate this when a job field may not
 *
 * > **The job's `vmTags` never gates. The tag read back from Proxmox may.**
 *
 * Same string, different provenance. A tag arriving on a job is MT's assertion, and gating on it
 * would let a compromised MT attach `free;until-…` to a delete for a paying customer's VM and
 * have this agent execute it unsigned. The tag ON THE LIVE VM is that VM's own state: MT holds no
 * hypervisor credentials, so it cannot retag anything after create. This is the identical
 * property `FOUNDATION_VM_PREFIX` relies on — the marker is **bound to the target**. It is not
 * unforgeability (MT chooses the tag at create, as it chooses the name); it is that forging buys
 * no reach, because the gate reads the state of the very VM the action destroys.
 *
 * ## The operator is in charge, and that is a feature
 *
 * `qm set --tags` at any time: clearing the `free` chip cancels the destruct, editing the date
 * extends the trial — both without asking MT. Not a threat surface, since the operator owns the
 * hardware and can destroy any VM regardless.
 *
 * ⛔ This module NEVER writes tags. The agent reads; it does not annotate.
 */

/** Required alongside a deadline. Two independent chips must agree before anything is destroyed. */
export const FREE_CHIP = "free";

/** The deadline chip, `until-YYYY-MM-DD`. */
const UNTIL_RE = /^until-(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Fence 4 — a deadline further in the past than this reads as BROKEN, not as overdue.
 *
 * Clock skew, a restored backup of a long-dead VM, a mis-parsed value: all of them produce a
 * wildly stale date, and none of them is a trial anyone is waiting to have reclaimed. Refusing is
 * the safe direction — the VM keeps running and the hub's own grace expiry (30 min) lands the
 * teardown in the operator's signing queue, where a human looks at it.
 */
export const MAX_OVERDUE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Parse an `until-YYYY-MM-DD` chip to the instant the deadline actually passes.
 *
 * **End of day UTC**, not midnight: the chip is a date because Proxmox colours a tag from its
 * text, so a per-VM-unique epoch would turn the tag column into a rainbow of one-off chips. A
 * date repeats across every trial issued that day and stays legible. The cost is that a trial may
 * run up to 24h past its nominal term, which for a free trial is nothing.
 *
 * Returns null for anything that is not exactly the expected shape — including a real-looking but
 * impossible date like `2026-02-31`, which `Date.UTC` would silently roll forward into March.
 */
export function parseUntilChip(chip: string): Date | null {
  const m = UNTIL_RE.exec(chip);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // End of the named day, UTC.
  const at = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  // Reject a date the calendar rolled over (2026-02-31 -> March 3).
  if (at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return at;
}

export type DestructVerdict =
  | { destroy: true; deadline: Date }
  | { destroy: false; reason: "no-deadline" | "not-free" | "unparseable" | "not-yet" | "too-stale" };

/**
 * Every fence, in one pure function — so all of them are testable without a hypervisor.
 *
 * 1. **`until-` must be present** and parse. No deadline, no destruct.
 * 2. **`free` must also be present.** The deadline alone is never sufficient; two independent
 *    chips must agree. This is what lets a `leased` VM advertise its loan end date in the same
 *    tag column without becoming destroyable — a loan is ENDED by its lender's agent verifying
 *    the signed `LoanRequest` in the description, never by a chip that merely asserts. A `paid`
 *    or `foundation` VM has no legitimate deadline at all (the hub throws on that combination),
 *    so one appearing here is a stamp-builder bug and this is the local second line against it.
 * 3. The deadline must actually have passed.
 * 4. …but not by more than `MAX_OVERDUE_MS` — wildly stale reads as broken (see above).
 *
 * Ownership — fence 3 in the plan's numbering — is NOT here on purpose: it is enforced by the
 * caller only ever passing VMs from `inventory.json`, which is a property of the list, not of a
 * VM's tags. A function that took tags could not check it even if it wanted to.
 */
export function shouldSelfDestruct(
  tags: string[],
  now: Date,
  opts: { maxOverdueMs?: number } = {}
): DestructVerdict {
  const maxOverdueMs = opts.maxOverdueMs ?? MAX_OVERDUE_MS;

  const untilChip = tags.find((t) => t.startsWith("until-"));
  if (!untilChip) return { destroy: false, reason: "no-deadline" };

  // Checked before the date parses, so a malformed deadline on a paying customer's VM reports
  // the more alarming of the two reasons.
  if (!tags.includes(FREE_CHIP)) return { destroy: false, reason: "not-free" };

  const deadline = parseUntilChip(untilChip);
  if (!deadline) return { destroy: false, reason: "unparseable" };

  const overdueMs = now.getTime() - deadline.getTime();
  if (overdueMs <= 0) return { destroy: false, reason: "not-yet" };
  if (overdueMs > maxOverdueMs) return { destroy: false, reason: "too-stale" };

  return { destroy: true, deadline };
}
