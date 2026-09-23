import type { HostAnswer } from "./scaffold";
import type { QemuVm } from "./proxmox-probe";
import { tierForVm } from "./proxmox-probe";

/**
 * The toolkit half of adopting an operator's existing Flux node VMs: which VMs to offer, and
 * when a mark in `inventory.json` has done its job.
 *
 * A mark (`existingVm` on a slot) keeps the hub from selling the slot and the agent from
 * building over the VM, until the operator clicks Adopt on /operator/fleet. Adopt renames the
 * VM to the slot's name — so the Proxmox listing itself says when a mark is finished, and a
 * re-run needs no hub call to know it.
 */

/** Proxmox node a host answer lives on. */
export function nodeOf(h: Pick<HostAnswer, "name" | "nodeName">): string {
  return h.nodeName ?? h.name;
}

/**
 * Drop marks that are finished, given a fresh VM listing per node:
 * - the VM now carries the slot's name → Adopt renamed it, the mark is done;
 * - the VMID is gone from the node → nothing left to adopt.
 * A node with no listing keeps its marks: unknown is not "gone".
 */
export function retireAdoptedMarks(
  hosts: HostAnswer[],
  vmsByNode: Record<string, QemuVm[]> | undefined
): { hosts: HostAnswer[]; notes: string[] } {
  const notes: string[] = [];
  const out = hosts.map((h) => {
    const vms = vmsByNode?.[nodeOf(h)];
    if (!vms) return h;
    return {
      ...h,
      slots: h.slots.map((s) => {
        if (!s.existingVm) return s;
        const vm = vms.find((v) => v.vmid === s.existingVm!.vmid);
        let why: string | undefined;
        if (!vm) why = `VM ${s.existingVm.vmid} is no longer on ${nodeOf(h)}`;
        else if (vm.name === s.vmName) why = `VM ${vm.vmid} was adopted (now named ${s.vmName})`;
        if (!why) return s;
        notes.push(`${s.vmName}: ${why} — existing-VM mark dropped.`);
        const { existingVm: _dropped, ...rest } = s;
        return rest;
      }),
    };
  });
  return { hosts: out, notes };
}

/** One line per candidate, e.g. `104 flux-node-1 · running · 4c/8 GB/220 GB → cumulus`. */
export function describeVm(vm: QemuVm): string {
  const gb = (b: number) => Math.round(b / 1024 ** 3);
  const tier = tierForVm(vm);
  return (
    `${vm.vmid} ${vm.name || "(no name)"} · ${vm.status} · ${vm.cpus}c/${gb(vm.maxmem)} GB/${gb(vm.maxdisk)} GB` +
    (tier ? ` → ${tier}?` : " → under cumulus size")
  );
}

/**
 * Parse "104, 107" against the node's VMs. Any listed VM may be picked, not only candidates —
 * the size rule is a hint. Returns the VMs in the order typed, or the problem to show.
 */
export function parseKeepList(answer: string, vms: QemuVm[]): QemuVm[] | string {
  const t = answer.trim().toLowerCase();
  if (t === "" || t === "none") return [];
  const picked: QemuVm[] = [];
  for (const part of t.split(",").map((p) => p.trim()).filter(Boolean)) {
    const id = Number(part);
    const vm = vms.find((v) => v.vmid === id);
    if (!vm) return `"${part}" is not a VMID on this host.`;
    if (!picked.includes(vm)) picked.push(vm);
  }
  return picked;
}
