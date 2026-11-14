import type { AgentConfig } from "./config";
import { getQemuList, getTaskStatus, stopVmNow, type Vm } from "./health";

/**
 * Teardown of a FRESH VM: hard-stop it before arcane-mage deletes it (tom 2026-11-14, option B).
 *
 * arcane-mage gives every running VM a graceful shutdown first, so FluxOS can remove the UPnP
 * port mappings it added. A VM only minutes old has no FluxOS up yet — nothing to clean — and
 * no guest agent either, so the graceful shutdown just fails ("QEMU Guest Agent is not running …
 * VM quit/powerdown failed - got timeout", staging MT2-0020, VM 109 at ~40 s) or waits out its
 * 120 s. Below `FRESH_VM_UPTIME_S` the agent stops it itself; arcane-mage then finds it stopped
 * and goes straight to the delete. Above it, nothing changes.
 *
 * Uptime only (no guest-agent ping): the ping needs a privilege the FluxHubAgent role does not
 * carry, and a node cannot install, start FluxOS and map UPnP inside ten minutes.
 *
 * Best-effort: any failure here (listing, stop, wait) leaves the VM to arcane-mage's usual path.
 */
export const FRESH_VM_UPTIME_S = 600;

/** Pure: is this VM fresh enough to skip the graceful shutdown? Unknown uptime = no. */
export function isFreshRunningVm(vm: Pick<Vm, "status" | "uptime">): boolean {
  return vm.status === "running" && typeof vm.uptime === "number" && vm.uptime >= 0 && vm.uptime < FRESH_VM_UPTIME_S;
}

export type FreshStopDeps = {
  list: (node: string) => Promise<Vm[]>;
  stop: (node: string, vmid: number) => Promise<string>;
  task: (node: string, upid: string) => Promise<{ status?: string; exitstatus?: string }>;
  sleep: (ms: number) => Promise<void>;
};

export function freshStopDeps(cfg: AgentConfig): FreshStopDeps {
  return {
    list: (node) => getQemuList(cfg, node),
    stop: (node, vmid) => stopVmNow(cfg, node, vmid),
    task: (node, upid) => getTaskStatus(cfg, node, upid),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

const STOP_WAIT_MS = 30_000;
const POLL_MS = 1_000;

/**
 * Hard-stop `vmName` on `nodeName` if it is a fresh running VM. Returns the line for the job
 * log, or null when it did nothing (not fresh, not found, or something failed — then the
 * line says so, and arcane-mage's graceful path runs as before).
 */
export async function hardStopIfFresh(vmName: string, nodeName: string, deps: FreshStopDeps): Promise<string | null> {
  let vm: Vm | undefined;
  try {
    vm = (await deps.list(nodeName)).find((v) => v.name === vmName);
  } catch {
    return null;
  }
  if (!vm || !isFreshRunningVm(vm)) return null;
  const vmid = typeof vm.vmid === "string" ? Number(vm.vmid) : vm.vmid;
  if (typeof vmid !== "number" || !Number.isInteger(vmid) || vmid <= 0) return null;

  const up = `up ${vm.uptime} s, under ${FRESH_VM_UPTIME_S} s: FluxOS can't have mapped UPnP yet`;
  try {
    const upid = await deps.stop(nodeName, vmid);
    for (let waited = 0; waited < STOP_WAIT_MS; waited += POLL_MS) {
      const t = await deps.task(nodeName, upid);
      if (t.status === "stopped") {
        return t.exitstatus === "OK"
          ? `Fresh VM ${vmName} (id=${vmid}, ${up}) — hard-stopped, no graceful shutdown`
          : `Fresh VM ${vmName}: hard stop ended ${t.exitstatus ?? "without a status"} — graceful path follows`;
      }
      await deps.sleep(POLL_MS);
    }
    return `Fresh VM ${vmName}: hard stop still running after ${STOP_WAIT_MS / 1000} s — graceful path follows`;
  } catch (e) {
    return `Fresh VM ${vmName}: hard stop failed (${(e as Error).message}) — graceful path follows`;
  }
}
