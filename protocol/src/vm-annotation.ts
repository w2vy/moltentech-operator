import { SIGNED_RECORD_DELIMITER } from "./signed-record";

/**
 * Stamp what a VM IS, and when it ends, onto the hypervisor itself — the shared builders.
 *
 * ## Why this is in `protocol` and not in the hub that wrote it first
 *
 * The hub builds this stamp for every VM it has a rental for. But a `loaned` VM has no hub
 * rental on the lender's side at all: `prudent-lending-lamport` §0.4 step 7 has the LENDER'S
 * AGENT provision the borrowed VM and stamp it, and the agent lives in another repo and cannot
 * import the hub. Leaving the builders hub-side would have meant the one kind that only the
 * agent can write was the one kind the agent had no way to build — so the `loaned` header would
 * have been retyped by hand on the far side of the wire, which is how two writers of one format
 * start to disagree.
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
 * trial self-destruct and lamport's loan scan, both of which read from the live VM.
 */

/** Exactly one of these describes any VM the hub creates. */
export type VmKind = "paid" | "free" | "foundation" | "loaned";

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
   * Present for `paid`, `free` AND `foundation`; omitted only for `loaned`. A Foundation
   * placement has a rental code of its own and it names no customer — the Foundation "customer"
   * is the platform itself — so stamping it discloses nothing to the operator that they do not
   * already own, and it is the fastest thread to pull when a `fh-` VM turns up on a hypervisor
   * with no claimant at the hub (which happened on staging 2026-09-03). `loaned` is the real
   * exclusion: that VM sits on ANOTHER operator's box, and the lender is not entitled to the
   * borrower's customer.
   */
  rentalCode?: string | null;
  /** Stripe subscription id; `paid` only. */
  subscriptionId?: string | null;
  /**
   * An IMMUTABLE deadline, or null when none exists. Null for `paid` (recurring, so any date
   * would be a lie after the first renewal) and for `foundation` (ends on eviction, not a clock).
   */
  deadline?: Date | null;
  /** `loaned` only — the two operators. Never a customer field: it sits on someone else's box. */
  borrowerSlug?: string | null;
  lenderSlug?: string | null;
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
    // `free` (a trial's fixed term) and `loaned` (a loan's) both genuinely end on a clock, and
    // seeing that date in the tag column is the point of the stamp. `paid` is recurring, so any
    // date would be a lie after the first renewal, and `foundation` ends on eviction, not on a
    // clock — a deadline on either is a stamp-builder bug.
    //
    // THROW, never drop the chip silently. The agent destroys an expired trial off this chip
    // with no job, no hub log and no signature, so there is no second party to catch a bad
    // stamp; and the two failure modes are not symmetric — a dropped chip means a trial runs
    // long (harmless), a wrong one destroys a node on schedule.
    //
    // ⚠️ The chip alone NEVER authorizes anything. The destruct gate requires `free` AND
    // `until-` (agent/src/trial-expiry.ts fence 2), which is what lets a `loaned` VM advertise
    // its loan end date here without becoming destroyable. A loan's expiry is still ENFORCED
    // from the signed `LoanRequest` in the description, which the lender's agent verifies; this
    // chip only makes the same fact visible on the hypervisor.
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

  if (input.kind === "loaned") {
    // No rental, no subscription, no customer identity: this VM sits on another operator's
    // hypervisor, and the lender is not entitled to the borrower's customer.
    if (input.borrowerSlug) rows.push(["borrower", input.borrowerSlug]);
    if (input.lenderSlug) rows.push(["lender", input.lenderSlug]);
  } else {
    if (input.rentalCode) rows.push(["rental", input.rentalCode]);
    rows.push(["tier", input.tier]);
    rows.push(["provider", input.providerSlug]);
    if (input.kind === "paid" && input.subscriptionId) rows.push(["sub", input.subscriptionId]);
  }

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
    case "loaned":
      return input.deadline
        ? `fixed — until ${isoMinutes(input.deadline)}`
        : "open-ended (ended by hand)";
  }
}
