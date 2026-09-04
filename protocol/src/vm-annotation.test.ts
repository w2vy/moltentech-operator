import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  PLATFORM_TAG,
  buildVmDescription,
  buildVmTags,
  type VmAnnotationInput,
} from "./vm-annotation";
import {
  SIGNED_RECORD_DELIMITER,
  joinSignedRecord,
  splitSignedRecord,
} from "./signed-record";

/**
 * The hub's own suite (apps/web/src/lib/vm-annotation.test.ts) still covers every kind through
 * the re-export, which is the contract that matters there. These are the cases that justify the
 * builders living HERE: the `loaned` stamp, which the lender's agent writes and the hub never
 * does, plus the invariants an agent-side caller could break without the hub noticing.
 */

const LOANED: VmAnnotationInput = {
  kind: "loaned",
  tier: "cumulus",
  providerSlug: "moltentech-test2",
  createdAt: new Date("2026-09-04T13:47:00.000Z"),
  borrowerSlug: "moltentech-test1",
  lenderSlug: "moltentech-test2",
  deadline: null,
};

test("a loaned stamp names both operators and NO customer", () => {
  // The lender is not entitled to the borrower's customer: this VM sits on the lender's box but
  // its occupant belongs to the borrower.
  const d = buildVmDescription(LOANED);
  assert.match(d, /borrower: moltentech-test1/);
  assert.match(d, /lender:   moltentech-test2/);
  assert.doesNotMatch(d, /rental|sub:/);
});

test("a loaned VM MAY carry a deadline chip — unlike paid or foundation", () => {
  // A loan genuinely ends on a clock, and seeing that date in the tag column is the point.
  // The destruct gate still needs `free` AND `until-`, so advertising it here is safe.
  const tags = buildVmTags({ ...LOANED, deadline: new Date("2026-09-05T12:00:00.000Z") });
  assert.equal(tags, `${PLATFORM_TAG};loaned;cumulus;until-2026-09-05`);
});

test("a paid or foundation VM with a deadline THROWS rather than stamping a stale date", () => {
  for (const kind of ["paid", "foundation"] as const) {
    assert.throws(
      () => buildVmTags({ ...LOANED, kind, deadline: new Date("2026-09-05T12:00:00.000Z") }),
      /no fixed deadline/,
      kind
    );
  }
});

test("a chip that fails the Proxmox charset is DROPPED, never mangled", () => {
  // Mangling would silently invent a value meaning something else; dropping only degrades.
  const tags = buildVmTags({ ...LOANED, tier: "Cumulus Plus!" });
  assert.equal(tags, `${PLATFORM_TAG};loaned`);
});

test("a field that would inject the delimiter is refused at build time", () => {
  assert.throws(
    () => buildVmDescription({ ...LOANED, borrowerSlug: `x\n${SIGNED_RECORD_DELIMITER}\ny` }),
    /falsely claims a signed record/
  );
});

test("the header a lender's agent builds round-trips through joinSignedRecord", () => {
  // The exact composition §0.4 step 7 performs: header from these builders, verbatim signed
  // record underneath.
  const header = buildVmDescription(LOANED);
  const record = '{"a":1}';
  const split = splitSignedRecord(joinSignedRecord(header, record));
  assert.equal(split.header, header);
  assert.equal(split.record, record);
});

test("no trailing newline, so Proxmox's one lossy behaviour is a no-op", () => {
  const d = buildVmDescription(LOANED);
  assert.doesNotMatch(d, /\n$/);
});
