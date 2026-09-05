import { SIGNED_RECORD_DELIMITER } from "./signed-record";

/**
 * Stamp what a VM IS, and when it ends, onto the hypervisor itself — the shared builders.
 *
 * ## Why this is in `protocol` and not in the hub that wrote it first
 *
 * The hub builds this stamp for every VM it has a rental for, and the AGENT reads it back off
 * the hypervisor to decide when a trial destroys itself. Both sides must agree on the format
 * byte for byte, and the agent lives in another repo and cannot import the hub — so the
 * builders live here, where both can reach exactly one definition of them.
 *
 * (They moved here for a fourth kind, `loaned`, that only the lender's agent could write. That
 * design was dropped 2026-09-05 and the kind removed with it; the reason for the SHARED
 * location outlived it, because the agent still reads what the hub writes.)
 *
 * This is the same move, for the same reason, as `signed-record.ts` next door: whatever both
 * sides must agree on byte for byte gets exactly one definition.
 *
 * ⭐ ONLY FIXED FACTS GO IN HERE. Nothing that can change after create is stamped, because there
 * is no refresh path and deliberately never will be: a stamp that can go stale is worse than no
 * stamp. So a recurring paid rental gets `term: recurring (monthly)` and NOT an `expiresAt` its
 * first renewal falsifies; a deadline is written only where one is genuinely immutable.
 *
 * The provenance rule governs how it may be READ: the job's `vmTags` never gates; the same tag
 * read back from Proxmox may (see `JobSlot.vmTags` in ./messages). Consumers today are liskov's
 * trial self-destruct, which reads from the live VM.
 */

/** Exactly one of these describes any VM the hub creates. */
export type VmKind = "paid" | "free" | "foundation";

/**
 * Proxmox tag charset (`pve-tag-id`): `[a-z0-9_][a-z0-9_\-+.]*`. Note there is NO COLON, which
 * is why the `until-` chip is day-precision — a timestamp lives in the description instead.
 */
const PVE_TAG_ID = /^[a-z0-9_][a-z0-9_\-+.]*$/;

/** The chip an operator filters on to separate platform VMs from their own. Always present. */
export const PLATFORM_TAG = "flux-hub";



export type VmAnnotationInput = {
  kind: VmKind;
  tier: string;
  providerSlug: string;
  createdAt: Date;
  /**
   * The hub's rental code.
   *
   * Present for every kind. A Foundation placement has a rental code of its own and it names no
   * customer — the Foundation "customer" is the platform itself — so stamping it discloses
   * nothing to the operator that they do not already own, and it is the fastest thread to pull
   * when a `fh-` VM turns up on a hypervisor with no claimant at the hub (which happened on
   * staging 2026-09-03).
   */
  rentalCode?: string | null;
  /** Stripe subscription id; `paid` only. */
  subscriptionId?: string | null;
  /**
   * An IMMUTABLE deadline, or null when none exists. Null for `paid` (recurring, so any date
   * would be a lie after the first renewal) and for `foundation` (ends on eviction, not a clock).
   */
  deadline?: Date | null;
};

function isoMinutes(d: Date): string {
  return `${d.toISOString().slice(0, 16)}Z`;
}

/**
 * The semicolon-joined chip list, e.g. `flux-hub;paid;cumulus` or
 * `flux-hub;free;nimbus;until-2026-09-30`.
 *
 * Low cardinality on purpose: Proxmox colours per distinct tag value, so a per-VM-unique chip
 * (a rental code, a timestamp) would destroy the tag column's usefulness across a whole fleet.
 * Identifiers belong in the description.
 *
 * A chip that fails the Proxmox charset is DROPPED, never mangled — a future tier or kind name
 * must not be able to produce a VM that Proxmox refuses to create. Dropping degrades the stamp;
 * mangling would silently invent a value that means something else.
 */
export function buildVmTags(input: VmAnnotationInput): string {
  const chips = [PLATFORM_TAG, input.kind, input.tier.toLowerCase()];
  if (input.deadline) {
    // 🔴 liskov fence 1 — a deadline chip may only appear where a deadline is REAL.
    //
    // `free` is the only kind with a real fixed term, and seeing that date in the tag column is
    // the point of the stamp. `paid` is recurring, so any date would be a lie after the first
    // renewal, and `foundation` ends on eviction, not on a clock — a deadline on either is a
    // stamp-builder bug.
    //
    // 📌 Since `loaned` was removed (2026-09-05) `free` is the ONLY kind that may carry a
    // deadline, so fence 1 here and fence 2 in the agent (`free` AND `until-`) now describe the
    // same set. That is a tightening, not a change of rule: the note below still holds and is
    // why the two fences stay separate.
    //
    // THROW, never drop the chip silently. The agent destroys an expired trial off this chip
    // with no job, no hub log and no signature, so there is no second party to catch a bad
    // stamp; and the two failure modes are not symmetric — a dropped chip means a trial runs
    // long (harmless), a wrong one destroys a node on schedule.
    //
    // ⚠️ The chip alone NEVER authorizes anything. The destruct gate requires `free` AND
    // `until-` (agent/src/trial-expiry.ts fence 2). Keeping the deadline chip and the destruct
    // gate as two separate conditions is what let a non-destroyable kind advertise an end date
    // here, and it is what will let the next one do so — so it stays two conditions.
    if (input.kind === "paid" || input.kind === "foundation") {
      throw new Error(
        `vm-annotation: a '${input.kind}' VM has no fixed deadline (recurring / ends on ` +
          `eviction) — refusing to stamp an 'until-' tag that would go stale`
      );
    }
    chips.push(`until-${input.deadline.toISOString().slice(0, 10)}`);
  }
  return chips.filter((c) => PVE_TAG_ID.test(c)).join(";");
}

/**
 * The `# flux-hub` header block that lands in the Proxmox Notes panel.
 *
 * Throws rather than emits if a field would inject the delimiter: a value that smuggles in a
 * `--- signed ---` line would make the header claim a signed record that nobody signed, and
 * every reader below the delimiter treats those bytes as authentic. Loud failure at build time
 * is the only safe direction, and no legitimate value contains that line.
 */
export function buildVmDescription(input: VmAnnotationInput): string {
  const rows: Array<[string, string]> = [["kind", input.kind]];

  if (input.rentalCode) rows.push(["rental", input.rentalCode]);
  rows.push(["tier", input.tier]);
  rows.push(["provider", input.providerSlug]);
  if (input.kind === "paid" && input.subscriptionId) rows.push(["sub", input.subscriptionId]);

  rows.push(["created", isoMinutes(input.createdAt)]);
  rows.push(["term", termLine(input)]);

  const width = Math.max(...rows.map(([k]) => k.length)) + 1;
  const body = rows.map(([k, v]) => `${(k + ":").padEnd(width + 1)}${v}`).join("\n");
  const text = `# ${PLATFORM_TAG}\n${body}`;

  if (text.split("\n").some((line) => line.trim() === SIGNED_RECORD_DELIMITER)) {
    throw new Error(
      "vm-annotation: a field would inject the signed-record delimiter — refusing to build a " +
        "header that falsely claims a signed record"
    );
  }
  return text;
}

function termLine(input: VmAnnotationInput): string {
  switch (input.kind) {
    case "paid":
      // Deliberately not a date. The first renewal would falsify one, and nothing refreshes it.
      return "recurring (monthly)";
    case "foundation":
      return "idle-fill — until evicted";
    case "free":
      return input.deadline
        ? `fixed — until ${isoMinutes(input.deadline)}`
        : "open-ended (ended by hand)";
  }
}
