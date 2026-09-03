import https from "node:https";
import type { AgentConfig } from "./config";
import type { NodeHealth } from "@moltentech/protocol";

// Operator Proxmox uses a self-signed cert; tolerate it for this LOCAL call only.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * One VM as the Proxmox node listing returns it.
 *
 * `tags` is included in `GET /nodes/{node}/qemu` — the same call `collectHealth` already makes
 * every cycle — so reading a VM's own marker costs **no extra API call**. It was simply being
 * discarded. See `trial-expiry.ts` for what may be done with it, and the provenance rule in
 * protocol/src/messages.ts for what may not: a tag read back FROM the hypervisor is the VM's own
 * state and may gate; the same string arriving on a job never may.
 */
type Vm = { name?: string; status?: string; tags?: string };

/** One owned VM as the agent sees it locally: its reported status, and its own tag chips. */
export type OwnedVm = {
  vmName: string;
  nodeName: string;
  /** `running` | `stopped` | … as Proxmox reports it, or `missing` when it is not there at all. */
  status: string;
  /** Parsed chips from the VM's own `tags`. Empty for a missing or untagged VM. */
  tags: string[];
};

/**
 * Split a Proxmox `tags` string into chips.
 *
 * Semicolon-separated, and lowercased because `pve-tag-id` is already a lowercase charset — so
 * normalising here means a hand-typed `Free` from an operator's `qm set --tags` reads the same
 * as the hub's own stamp. Shared by the sweep and its tests so there is exactly one parser.
 */
export function parseVmTags(tags?: string | null): string[] {
  if (!tags) return [];
  return tags
    .split(";")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/** GET a Proxmox API path via the local token, returning its `data` payload. */
function getJson<T>(cfg: AgentConfig, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${cfg.proxmox.url}${path}`);
    const r = https.request(
      url,
      {
        method: "GET",
        agent: insecureAgent,
        headers: {
          Authorization: `PVEAPIToken=${cfg.proxmox.tokenId}=${cfg.proxmox.tokenSecret}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`proxmox ${res.statusCode}`));
          }
          try {
            resolve((JSON.parse(data).data ?? []) as T);
          } catch (e) {
            reject(e as Error);
          }
        });
      }
    );
    r.on("error", reject);
    r.end();
  });
}

/** GET the VM list for one Proxmox node via the local API token. */
function getQemuList(cfg: AgentConfig, nodeName: string): Promise<Vm[]> {
  return getJson<Vm[]>(cfg, `/api2/json/nodes/${nodeName}/qemu`);
}

/**
 * Every VMID currently live on the CLUSTER — qemu and lxc, every node, including VMs
 * that have nothing to do with MT.
 *
 * Cluster-wide on purpose: a VMID is unique per cluster, not per node, so a per-node
 * listing would happily hand out an id already taken on another host. `/cluster/resources`
 * answers from any member, which is why one `PROXMOX_URL` is enough.
 *
 * Foreign VMs are exactly why D3-B allocates here and not on the hub: MT holds no
 * hypervisor credentials and cannot see them.
 */
export async function getClusterVmIds(cfg: AgentConfig): Promise<Set<number>> {
  const raw = await getJson<{ vmid?: number | string }[]>(cfg, "/api2/json/cluster/resources?type=vm");
  const ids = new Set<number>();
  for (const r of raw) {
    const n = typeof r.vmid === "string" ? Number(r.vmid) : r.vmid;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) ids.add(n);
  }
  return ids;
}

/**
 * Build a NodeHealth[] for the agent's owned VMs by querying the LOCAL Proxmox.
 * If a hypervisor is unreachable we report nothing for its VMs (not "down") — the
 * MT-side staleness check covers an unreachable agent/hypervisor, so we never emit
 * a false down just because the API call failed.
 */
export async function collectHealth(
  cfg: AgentConfig,
  owned: { vmName: string; nodeName: string }[]
): Promise<NodeHealth[]> {
  const vms = await collectOwnedVms(cfg, owned);
  return vms.map(({ vmName, status }) => ({ vmName, running: status === "running", status }));
}

/**
 * The same single pass, before it is narrowed to what the hub is told.
 *
 * `collectHealth` is a projection of this and nothing else, so the trial sweep and the health
 * report can never disagree about what is on the hypervisor — and neither costs a second query.
 * The hub deliberately never receives `tags`: the marker is the operator's own state, read
 * locally, acted on locally.
 */
export async function collectOwnedVms(
  cfg: AgentConfig,
  owned: { vmName: string; nodeName: string }[]
): Promise<OwnedVm[]> {
  const byNode = new Map<string, string[]>();
  for (const n of owned) {
    const list = byNode.get(n.nodeName) ?? [];
    list.push(n.vmName);
    byNode.set(n.nodeName, list);
  }

  const out: OwnedVm[] = [];
  for (const [nodeName, vmNames] of byNode) {
    let vms: Vm[];
    try {
      vms = await getQemuList(cfg, nodeName);
    } catch (err) {
      console.error(
        `[health] proxmox query failed for node ${nodeName}: ${(err as Error).message}`
      );
      continue; // skip — staleness will catch a persistently-unreachable hypervisor
    }
    out.push(...ownedVmsForNode(nodeName, vmNames, vms));
  }
  return out;
}

/**
 * Join one node's Proxmox listing against the names this agent OWNS — the pure half, and the
 * place fence 3 actually lives.
 *
 * 🔒 The iteration direction is the fence. It walks `vmNames` (from `inventory.json`) and looks
 * each one up in the hypervisor listing — never the reverse — so a VM on the box that the agent
 * does not manage cannot appear in the output at all, whatever it is tagged. The trial sweep
 * consumes this list and only this list, which is why it can never reach an operator's own
 * unrelated VM.
 *
 * A declared name with no matching VM is `missing` with no tags: absence is a fact worth
 * reporting, and an absent VM is nothing to act on.
 */
export function ownedVmsForNode(
  nodeName: string,
  vmNames: string[],
  vms: Array<{ name?: string; status?: string; tags?: string }>
): OwnedVm[] {
  const byName = new Map(vms.map((v) => [v.name, v]));
  return vmNames.map((vmName) => {
    const vm = byName.get(vmName);
    return vm
      ? { vmName, nodeName, status: String(vm.status ?? "unknown"), tags: parseVmTags(vm.tags) }
      : { vmName, nodeName, status: "missing", tags: [] };
  });
}
