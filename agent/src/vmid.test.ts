import { test } from "node:test";
import assert from "node:assert/strict";
import { seedFrom, nextFree, allocateVmId, resetCursor, peekCursor, VMID_MIN, VMID_MAX } from "./vmid";

// ── seedFrom ───────────────────────────────────────────────────────────────────

test("seedFrom: starts above the highest live id, not at the bottom of the range", () => {
  // The whole point of D3-B. Seeding low and skipping in-use ids re-walks the bottom
  // after every restart and re-issues long-destroyed ids — the reuse being removed.
  assert.equal(seedFrom([100, 101, 105]), 106);
});

test("seedFrom: an empty cluster starts at the floor", () => {
  assert.equal(seedFrom([]), VMID_MIN);
});

test("seedFrom: ignores ids outside the range", () => {
  // Proxmox reserves < 100, and an operator may run ids above our ceiling; neither
  // should drag the seed somewhere useless.
  assert.equal(seedFrom([1, 99, 20000]), VMID_MIN);
  assert.equal(seedFrom([99, 150, 100000]), 151);
});

test("seedFrom: wraps rather than seeding out of range", () => {
  assert.equal(seedFrom([VMID_MAX]), VMID_MIN);
});

// ── nextFree ───────────────────────────────────────────────────────────────────

test("nextFree: returns the cursor itself when free, and advances", () => {
  assert.deepEqual(nextFree(200, new Set()), { vmId: 200, cursor: 201 });
});

test("nextFree: steps over ids in use, including foreign VMs", () => {
  // Foreign VMs are why this is allocated agent-side at all: MT holds no hypervisor
  // credentials and cannot see anything it did not create.
  assert.deepEqual(nextFree(200, new Set([200, 201, 202])), { vmId: 203, cursor: 204 });
});

test("nextFree: wraps at the ceiling", () => {
  assert.deepEqual(nextFree(VMID_MAX, new Set()), { vmId: VMID_MAX, cursor: VMID_MIN });
  assert.deepEqual(nextFree(VMID_MAX, new Set([VMID_MAX])), { vmId: VMID_MIN, cursor: VMID_MIN + 1 });
});

test("nextFree: a cursor outside the range restarts at the floor", () => {
  assert.equal(nextFree(5, new Set())?.vmId, VMID_MIN);
  assert.equal(nextFree(50000, new Set())?.vmId, VMID_MIN);
});

test("nextFree: a full range returns null rather than looping forever", () => {
  // 9,900 live VMs is a real cluster condition, not an internal error — the caller
  // decides (we fall back to letting Proxmox allocate).
  const full = new Set<number>();
  for (let i = VMID_MIN; i <= VMID_MAX; i++) full.add(i);
  assert.equal(nextFree(VMID_MIN, full), null);
});

// ── allocateVmId (cursor behaviour) ────────────────────────────────────────────

test("allocateVmId: climbs instead of reusing a freed id", async () => {
  resetCursor();
  // The measured failure this fixes: 105 destroyed on an otherwise-empty pve30, and
  // /cluster/nextid offers 105 straight back. Rotation must not.
  const live = new Set([100, 101, 102, 103, 104, 105]);
  assert.equal(await allocateVmId(async () => live), 106);

  live.delete(105); // the VM is destroyed
  assert.equal(await allocateVmId(async () => live), 107, "must not fall back to the freed 105");
});

test("allocateVmId: consecutive calls never repeat within a process", async () => {
  resetCursor();
  const live = new Set([100]);
  const got = [
    await allocateVmId(async () => live),
    await allocateVmId(async () => live),
    await allocateVmId(async () => live),
  ];
  assert.deepEqual(got, [101, 102, 103]);
  assert.equal(new Set(got).size, 3);
});

test("allocateVmId: re-seeds from the live cluster on a cold start", async () => {
  // No persistence by design: Proxmox holds the high-water mark, so a restart picks
  // up above the live maximum rather than back at the floor.
  resetCursor();
  assert.equal(peekCursor(), null);
  assert.equal(await allocateVmId(async () => new Set([100, 400])), 401);
});

test("allocateVmId: skips an id taken since the last allocation", async () => {
  resetCursor();
  const live = new Set([100]);
  assert.equal(await allocateVmId(async () => live), 101);
  live.add(102); // something else grabbed it in the meantime
  assert.equal(await allocateVmId(async () => live), 103);
});

test("allocateVmId: a full range yields null, not a throw", async () => {
  resetCursor();
  const full = new Set<number>();
  for (let i = VMID_MIN; i <= VMID_MAX; i++) full.add(i);
  assert.equal(await allocateVmId(async () => full), null);
});
