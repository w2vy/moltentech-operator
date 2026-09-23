import type { ExistingVm, FailureClass, InventoryHost, Job } from "@moltentech/protocol";

/**
 * Existing node VMs the operator marked in `inventory.json` (`InventorySlot.existingVm`).
 *
 * Two jobs live here, both pure so the suite drives them with plain listings:
 *
 * - **The fence.** A provision/reprovision/move onto a marked slot is refused while the marked
 *   VMID is still on the host. It is enforced HERE, not only on the hub, so an older hub that
 *   never heard of the mark still cannot build a second node over the running one (or, for a
 *   reprovision, destroy it first). Once that VM is gone — the adopted rental ended and it was
 *   deleted — the fence lifts on its own, so a stale mark left in the file can't brick the slot.
 * - **The rename.** Adopt renames the VM to the slot's prefixed name. The agent renames only a
 *   VM the operator declared: the job's `vmid` and `from` must both match the mark (fence 3).
 */

/** The mark on the inventory slot this job targets (matched by node + new slot name). */
export function existingVmFor(hosts: InventoryHost[], nodeName: string, vmName: string): ExistingVm | undefined {
  for (const h of hosts) {
    if (h.nodeName !== nodeName && h.name !== nodeName) continue;
    const slot = h.slots.find((s) => s.vmName === vmName);
    if (slot?.existingVm) return slot.existingVm;
  }
  return undefined;
}

/** A node's VMs as the fence needs them: VMID → current name. `null` = the listing failed. */
export type VmListing = Map<number, string> | null;

export type Refusal = { ok: false; message: string; failureClass: FailureClass };

const BUILDING_ACTIONS = new Set<Job["action"]>(["provision", "reprovision", "move"]);

/**
 * May this job build a VM on its slot? `null` = yes; otherwise the refusal to report.
 *
 * An unreadable listing refuses as `transient`: presence is unknown, and guessing "gone" is the
 * one mistake that builds over a running node.
 */
export function existingVmFence(job: Job, mark: ExistingVm | undefined, listing: VmListing): Refusal | null {
  if (!mark || !BUILDING_ACTIONS.has(job.action)) return null;
  if (listing === null) {
    return {
      ok: false,
      message: `slot ${job.slot.vmName} is marked as holding existing VM ${mark.vmid} and the host listing failed; not building`,
      failureClass: "transient",
    };
  }
  if (!listing.has(mark.vmid)) return null; // the marked VM is gone: fence lifted
  return {
    ok: false,
    message:
      `slot ${job.slot.vmName} holds an existing VM (${mark.vmid} ${listing.get(mark.vmid)}); ` +
      "adopt it on /operator/fleet",
    failureClass: "permanent",
  };
}

export type RenamePlan = { kind: "done" } | { kind: "rename"; vmid: number } | Refusal;

/**
 * What a `rename` job should do, given the mark and the host listing.
 *
 * Idempotent: a VM already carrying the new name is success, so a lease that expired after the
 * PUT landed re-runs harmlessly.
 */
export function planRename(job: Job, mark: ExistingVm | undefined, listing: VmListing): RenamePlan {
  const to = job.slot.vmName;
  const refuse = (message: string, failureClass: FailureClass = "permanent"): Refusal => ({
    ok: false,
    message,
    failureClass,
  });
  if (!job.rename) return refuse("rename job carries no rename target");
  const { vmid, from } = job.rename;
  if (!mark) return refuse(`slot ${to} has no existingVm in inventory.json; the agent renames only VMs you declared`);
  if (mark.vmid !== vmid || mark.name !== from) {
    return refuse(
      `rename ${vmid} ${from} does not match the declared existing VM ${mark.vmid} ${mark.name} on slot ${to}`
    );
  }
  if (listing === null) return refuse(`host listing failed; cannot rename ${vmid}`, "transient");
  const current = listing.get(vmid);
  if (current === undefined) return refuse(`VM ${vmid} is not on node ${job.slot.nodeName}`);
  if (current === to) return { kind: "done" };
  if (current !== from) return refuse(`VM ${vmid} is named ${current}, not ${from}; not renaming`);
  // Two VMs with one name would make name-keyed health and delete ambiguous.
  for (const [id, name] of listing) {
    if (id !== vmid && name === to) return refuse(`another VM (${id}) is already named ${to}`);
  }
  return { kind: "rename", vmid };
}

/** Build a listing from the Proxmox `GET /nodes/{node}/qemu` rows. */
export function toListing(vms: Array<{ name?: string; vmid?: number | string }>): Map<number, string> {
  const m = new Map<number, string>();
  for (const v of vms) {
    const id = typeof v.vmid === "string" ? Number(v.vmid) : v.vmid;
    if (typeof id === "number" && Number.isInteger(id) && id > 0) m.set(id, v.name ?? "");
  }
  return m;
}
