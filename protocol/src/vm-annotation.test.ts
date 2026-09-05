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
 * the re-export, which is the contract that matters there. These are the invariants an
 * agent-side caller could break without the hub noticing.
 *
 * (This file used to be built around a fourth kind, `loaned`, that only the lender's agent
 * wrote. The loan design was dropped 2026-09-05 and the kind with it; the cases below were the
 * ones that were never about `loaned` in the first place, rewritten onto `free` — the kind the
 * agent actually acts on.)
 */

const FREE: VmAnnotationInput = {
  kind: "free",
  tier: "cumulus",
  providerSlug: "moltentech-test2",
  createdAt: new Date("2026-09-04T13:47:00.000Z"),
  rentalCode: "MT-0080",
  deadline: null,
};

test("a free VM MAY carry a deadline chip — unlike paid or foundation", () => {
  // A trial genuinely ends on a clock, and seeing that date in the tag column is the point.
  // Since `loaned` was removed, `free` is the ONLY kind that may carry one.
  const tags = buildVmTags({ ...FREE, deadline: new Date("2026-09-05T12:00:00.000Z") });
  assert.equal(tags, `${PLATFORM_TAG};free;cumulus;until-2026-09-05`);
});

test("a paid or foundation VM with a deadline THROWS rather than stamping a stale date", () => {
  for (const kind of ["paid", "foundation"] as const) {
    assert.throws(
      () => buildVmTags({ ...FREE, kind, deadline: new Date("2026-09-05T12:00:00.000Z") }),
      /no fixed deadline/,
      kind
    );
  }
});

test("a chip that fails the Proxmox charset is DROPPED, never mangled", () => {
  // Mangling would silently invent a value meaning something else; dropping only degrades.
  const tags = buildVmTags({ ...FREE, tier: "Cumulus Plus!" });
  assert.equal(tags, `${PLATFORM_TAG};free`);
});

test("a field that would inject the delimiter is refused at build time", () => {
  assert.throws(
    () => buildVmDescription({ ...FREE, providerSlug: `x\n${SIGNED_RECORD_DELIMITER}\ny` }),
    /falsely claims a signed record/
  );
});

test("the header round-trips through joinSignedRecord", () => {
  // A header from these builders, a verbatim signed record underneath: whatever is written
  // below the delimiter must come back byte-identical.
  const header = buildVmDescription(FREE);
  const record = '{"a":1}';
  const split = splitSignedRecord(joinSignedRecord(header, record));
  assert.equal(split.header, header);
  assert.equal(split.record, record);
});

test("no trailing newline, so Proxmox's one lossy behaviour is a no-op", () => {
  const d = buildVmDescription(FREE);
  assert.doesNotMatch(d, /\n$/);
});
