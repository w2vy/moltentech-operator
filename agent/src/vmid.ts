/**
 * D3-B — monotonic VMID allocation, agent-side.
 *
 * WHY: Proxmox's `/cluster/nextid` hands out the LOWEST free id, so an id freed by a
 * teardown is the very next one issued. Measured 2026-08-10: after destroying VM 105
 * on an otherwise-empty pve30, `pvesh get /cluster/nextid` returned 105 again. The
 * result is a log where the same VMID names a series of unrelated nodes belonging to
 * different customers — `ProvisionLog` on staging had four jobs and one distinct id.
 *
 * Climbing instead of reusing makes a VMID mean one node for as long as the range
 * lasts (~9,900 ids against a fleet of ~21 live / ~64 max slots).
 *
 * WHY NO PERSISTENCE: the counter is in memory and re-seeded on start from the live
 * cluster, because **Proxmox already stores it** — the set of live VMIDs is durable
 * state maintained by the component that actually knows, and it survives every agent
 * restart, host reboot and rebuild. A file would need a writable volume the agents
 * don't have (prod `/config` and test1 `/data` are both mounted read-only), and a
 * tmpfs file was tested and has the lifetime of an in-process variable: gone after
 * `docker restart`, gone after `rm` + `run`.
 *
 * The one case this does not cover: an agent restart AFTER the highest-numbered VM
 * was destroyed re-seeds below it, so that id can be issued twice. It is bounded to
 * ids above the surviving maximum, where lowest-free makes EVERY freed id the next
 * one out. If that becomes unacceptable, the durable-counter design (MT holds it in
 * `Settings`, the agent still validates in-use) is written up in the plan artifact.
 */

/** Proxmox reserves < 100. 9999 keeps ids four digits, which is what makes logs skimmable. */
export const VMID_MIN = 100;
export const VMID_MAX = 9999;

/**
 * First id to hand out, given every VMID currently live on the cluster.
 *
 * ⚠️ Seeds at the live MAXIMUM, deliberately not at VMID_MIN. Starting low and
 * skipping in-use ids re-walks the bottom of the range after every restart and
 * re-issues ids belonging to long-destroyed VMs — precisely the reuse this exists to
 * remove. Live VMs are the high-water mark.
 */
export function seedFrom(inUse: Iterable<number>): number {
  let max = VMID_MIN - 1;
  for (const id of inUse) {
    if (Number.isInteger(id) && id >= VMID_MIN && id <= VMID_MAX && id > max) max = id;
  }
  return max + 1 > VMID_MAX ? VMID_MIN : max + 1;
}

/**
 * Pick the next free id at or after `from`, wrapping once at VMID_MAX.
 *
 * Returns the id plus the cursor to resume from, so the caller owns the state and
 * this stays pure. Null when the whole range is occupied — a real cluster condition
 * (9,900 VMs), not an internal error, so the caller decides what to do about it.
 */
export function nextFree(from: number, inUse: ReadonlySet<number>): { vmId: number; cursor: number } | null {
  const span = VMID_MAX - VMID_MIN + 1;
  let candidate = from < VMID_MIN || from > VMID_MAX ? VMID_MIN : from;
  for (let i = 0; i < span; i++) {
    if (!inUse.has(candidate)) {
      const cursor = candidate + 1 > VMID_MAX ? VMID_MIN : candidate + 1;
      return { vmId: candidate, cursor };
    }
    candidate = candidate + 1 > VMID_MAX ? VMID_MIN : candidate + 1;
  }
  return null;
}

/**
 * The process-lifetime cursor. Module-level on purpose: one agent process serves one
 * operator's cluster, and within that process the counter only ever climbs.
 */
let cursor: number | null = null;

/** Testing seam — reset the cursor between cases. */
export function resetCursor(): void {
  cursor = null;
}

/** Current cursor, or null before the first allocation. Exposed for logging/tests. */
export function peekCursor(): number | null {
  return cursor;
}

/**
 * Allocate the next VMID, seeding from the live cluster on first use.
 *
 * `listInUse` is injected rather than imported so this is testable without Proxmox,
 * and so the caller controls the failure policy: a listing failure here should NOT
 * fail the provision — the caller omits `vm_id` and lets arcane-mage fall back to
 * `/cluster/nextid`, which is exactly the pre-D3-B behaviour. Rotation is a
 * readability improvement, and it must never be the reason a customer's node fails
 * to build.
 */
export async function allocateVmId(listInUse: () => Promise<Set<number>>): Promise<number | null> {
  const inUse = await listInUse();
  if (cursor == null) cursor = seedFrom(inUse);
  const picked = nextFree(cursor, inUse);
  if (!picked) return null;
  cursor = picked.cursor;
  return picked.vmId;
}
