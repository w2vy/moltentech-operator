/**
 * The `--- signed ---` stamp layout — the ONE definition, shared by signer and verifier.
 *
 * A VM's Proxmox `description` carries a human-readable header (built by the hub) and, below a
 * delimiter line, a **verbatim signed record**. `prudent-lending-lamport` §9d.3 makes that stamp
 * the lender's agent's durable loan state: the agent has no writable volume, so after a restart
 * the borrowed VM's own config is the only place it can learn which loan it provisioned under,
 * for whom, and when. Because the record is self-authenticating on read, the hub is not on that
 * path at all and cannot rewind an expiry.
 *
 * ## Why this lives in `protocol` and not beside the header builder
 *
 * The hub writes the stamp (`apps/web/src/lib/vm-annotation.ts`); the lender's **agent** verifies
 * it. Two repos, two processes — and the plan's own rule is that "signer and verifier must
 * normalise identically … in the shared helper rather than in each caller". A second copy of
 * `stripTrailingNewlines` is exactly the bug that rule exists to prevent: a signer emitting
 * `canonicalize(x) + "\n"` verifies fine locally and fails only after a Proxmox round trip, with
 * nothing in the failure pointing at a newline. So `protocol` owns it and the hub re-exports.
 *
 * ## The one lossy thing Proxmox does
 *
 * ✅ Measured on pve55, PVE 9.2.4 (2026-09-01), and again on prod pve30 (2026-09-04, VMID 219,
 * 185 bytes byte-identical): the `description` round trip is lossless **except that all trailing
 * newlines are stripped**. `"x\n"` and `"x\n\n\n"` both read back as `"x"`. Everything else
 * survives byte for byte — `#` lines, the exact line `--- signed ---`, interior blanks, leading
 * and trailing spaces, tabs, backslashes, non-ASCII, `%` and `:`.
 *
 * So the signed record is DEFINED as the bytes below the delimiter with trailing newlines
 * stripped. No base64: it was the fallback and the measurement made it unnecessary.
 */

/** The line that separates the human-readable header from the verbatim signed record. */
export const SIGNED_RECORD_DELIMITER = "--- signed ---";

/**
 * The normalisation the round trip forces. Trailing newlines only — never leading, never
 * interior, and never whitespace other than `\n`, because all of those DO survive and stripping
 * them would make the verifier hash something the signer never emitted.
 */
export function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}

/**
 * Split a description into its header and any verbatim signed record.
 *
 * `record` is null when there is no delimiter. The record is otherwise opaque: no reflow, no
 * re-indent, no parsing, no trimming beyond the trailing-newline rule above.
 *
 * ⚠️ The FIRST delimiter wins. A value that smuggles a second one in cannot truncate the record
 * or start a new one — and the hub refuses at build time to emit a header containing the
 * delimiter at all, so the two halves of that defence sit on both sides of the wire.
 */
export function splitSignedRecord(description: string): { header: string; record: string | null } {
  const lines = description.split("\n");
  const i = lines.findIndex((line) => line === SIGNED_RECORD_DELIMITER);
  if (i === -1) return { header: stripTrailingNewlines(description), record: null };
  return {
    header: lines.slice(0, i).join("\n"),
    record: stripTrailingNewlines(lines.slice(i + 1).join("\n")),
  };
}

/**
 * Join a header and a signed record into the description that goes on the VM.
 *
 * The record is normalised on the way IN as well as on the way out, so what the signer hands
 * over is what a verifier will hash after the round trip — the write path and the read path
 * agree by construction rather than by both remembering to call the same helper.
 *
 * Throws if the header itself contains the delimiter: a header that falsely announces a signed
 * record would have every reader below the line treat unsigned bytes as authentic.
 */
export function joinSignedRecord(header: string, record: string): string {
  if (header.split("\n").some((line) => line === SIGNED_RECORD_DELIMITER)) {
    throw new Error(
      "signed-record: the header already contains the delimiter — refusing to build a " +
        "description whose signed section would be ambiguous"
    );
  }
  return `${stripTrailingNewlines(header)}\n${SIGNED_RECORD_DELIMITER}\n${stripTrailingNewlines(record)}`;
}
