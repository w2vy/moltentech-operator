/**
 * The fences on the one action this agent takes with no job, no signature and no hub.
 *
 * Every one of them is here rather than on a hypervisor, because the failure they guard against
 * is a bug in the hub's stamp builder — and with MT out of the expiry loop there is no second
 * party to catch it. A wrongly-emitted `until-` chip on a paying customer's VM destroys their
 * node on schedule, silently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldSelfDestruct,
  parseUntilChip,
  MAX_OVERDUE_MS,
  FREE_CHIP,
} from "./trial-expiry";
import { parseVmTags, ownedVmsForNode } from "./health";

const NOW = new Date("2026-09-03T12:00:00Z");
const tags = (s: string) => parseVmTags(s);

test("destroys a free VM whose deadline has passed", () => {
  const v = shouldSelfDestruct(tags("flux-hub;free;cumulus;until-2026-09-01"), NOW);
  assert.equal(v.destroy, true);
});

test("fence 2 — a deadline WITHOUT the free chip is refused, whatever else it says", () => {
  for (const kind of ["paid", "foundation", "loaned"]) {
    const v = shouldSelfDestruct(tags(`flux-hub;${kind};cumulus;until-2026-09-01`), NOW);
    assert.deepEqual(v, { destroy: false, reason: "not-free" }, `${kind} must be refused`);
  }
});

test("a LOANED VM's loan end date is visible but never destroyable", () => {
  // The hub legitimately stamps `until-` on a loaned VM so the loan's end shows in the tag
  // column. Two chips must agree, so that visibility can never become an unsigned destroy —
  // a loan ends by its lender's agent verifying the signed LoanRequest, not by this chip.
  const v = shouldSelfDestruct(tags("flux-hub;loaned;stratus;until-2020-01-01"), NOW);
  assert.deepEqual(v, { destroy: false, reason: "not-free" });
});

test("a free VM with NO deadline is never touched", () => {
  // An unbounded free rental (termDays null) carries no chip and must run until ended by hand.
  const v = shouldSelfDestruct(tags("flux-hub;free;cumulus"), NOW);
  assert.deepEqual(v, { destroy: false, reason: "no-deadline" });
});

test("an untagged VM is never touched", () => {
  assert.deepEqual(shouldSelfDestruct([], NOW), { destroy: false, reason: "no-deadline" });
});

test("before the deadline, nothing happens", () => {
  const v = shouldSelfDestruct(tags("flux-hub;free;cumulus;until-2026-09-04"), NOW);
  assert.deepEqual(v, { destroy: false, reason: "not-yet" });
});

test("the boundary is END of day UTC, not midnight", () => {
  const chip = "flux-hub;free;cumulus;until-2026-09-03";
  // 12:00 on the day itself — still inside the term.
  assert.deepEqual(shouldSelfDestruct(tags(chip), NOW), { destroy: false, reason: "not-yet" });
  // One second into the next day — over.
  assert.equal(
    shouldSelfDestruct(tags(chip), new Date("2026-09-04T00:00:00Z")).destroy,
    true
  );
  // The last millisecond of the named day is still inside it.
  assert.deepEqual(shouldSelfDestruct(tags(chip), new Date("2026-09-03T23:59:59.999Z")), {
    destroy: false,
    reason: "not-yet",
  });
});

test("fence 4 — an absurdly stale deadline reads as broken, not as overdue", () => {
  // A restored backup of a long-dead VM, or a clock way out. Refusing keeps the VM alive and
  // lets the hub's grace put a teardown in front of a human instead.
  const v = shouldSelfDestruct(tags("flux-hub;free;cumulus;until-2020-01-01"), NOW);
  assert.deepEqual(v, { destroy: false, reason: "too-stale" });
});

test("fence 4 — the cutoff is honoured exactly", () => {
  const deadline = new Date(NOW.getTime() - MAX_OVERDUE_MS + 2 * 86_400_000);
  const chip = `flux-hub;free;cumulus;until-${deadline.toISOString().slice(0, 10)}`;
  assert.equal(shouldSelfDestruct(tags(chip), NOW).destroy, true);
});

test("an unparseable deadline is refused, never guessed at", () => {
  for (const bad of ["until-2026-9-1", "until-tomorrow", "until-2026-13-01", "until-2026-02-31"]) {
    const v = shouldSelfDestruct([FREE_CHIP, bad], NOW);
    assert.deepEqual(v, { destroy: false, reason: "unparseable" }, `${bad} must not parse`);
  }
});

test("parseUntilChip returns end-of-day UTC", () => {
  assert.equal(
    parseUntilChip("until-2026-09-30")?.toISOString(),
    "2026-09-30T23:59:59.999Z"
  );
  assert.equal(parseUntilChip("cumulus"), null);
});

test("tag parsing is tolerant of an operator's own hand-typed edit", () => {
  // `qm set --tags` is the documented escape hatch: clearing `free` cancels the destruct,
  // editing the date extends the trial. Case and spacing must not change the answer.
  assert.deepEqual(parseVmTags(" Flux-Hub ; FREE ; Cumulus ; Until-2026-09-01 "), [
    "flux-hub",
    "free",
    "cumulus",
    "until-2026-09-01",
  ]);
  assert.equal(shouldSelfDestruct(parseVmTags("free;until-2026-09-01"), NOW).destroy, true);
  // Chip removed by hand ⇒ the destruct is cancelled.
  assert.equal(shouldSelfDestruct(parseVmTags("flux-hub;cumulus"), NOW).destroy, false);
});

test("fence 3 — a foreign VM on the box is never a candidate, however it is tagged", () => {
  const listing = [
    { name: "ms-186-c6", status: "running", tags: "flux-hub;free;cumulus;until-2026-09-01" },
    // The operator's own VM, tagged identically. It is not in inventory.json, so it must not
    // even appear in the list the sweep iterates.
    { name: "toms-nas", status: "running", tags: "flux-hub;free;cumulus;until-2026-09-01" },
  ];
  const owned = ownedVmsForNode("pve50", ["ms-186-c6"], listing);
  assert.deepEqual(
    owned.map((v) => v.vmName),
    ["ms-186-c6"]
  );
});

test("a declared VM that is not on the hypervisor reports missing, with no tags", () => {
  const owned = ownedVmsForNode("pve50", ["ms-186-c8"], []);
  // `vmid: null` alongside the empty tags: absent means there is nothing to address either.
  assert.deepEqual(owned, [
    { vmName: "ms-186-c8", nodeName: "pve50", status: "missing", tags: [], vmid: null },
  ]);
});

test("a VM that IS on the hypervisor carries its vmid through", () => {
  const owned = ownedVmsForNode("pve50", ["ms-186-c6"], [
    { name: "ms-186-c6", status: "running", tags: "flux-hub;loaned;cumulus", vmid: 101 },
  ]);
  assert.equal(owned[0]?.vmid, 101);
});

test("a vmid Proxmox returns as a STRING is normalised to a number", () => {
  const owned = ownedVmsForNode("pve50", ["ms-186-c6"], [
    { name: "ms-186-c6", status: "running", tags: "", vmid: "101" },
  ]);
  assert.equal(owned[0]?.vmid, 101);
});
