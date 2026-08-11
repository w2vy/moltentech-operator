import https from "node:https";
import type { AgentConfig } from "./config";
import type { NodeHealth } from "@moltentech/protocol";

// Operator Proxmox uses a self-signed cert; tolerate it for this LOCAL call only.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

type Vm = { name?: string; status?: string };

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
  const byNode = new Map<string, string[]>();
  for (const n of owned) {
    const list = byNode.get(n.nodeName) ?? [];
    list.push(n.vmName);
    byNode.set(n.nodeName, list);
  }

  const out: NodeHealth[] = [];
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
    const byName = new Map(vms.map((v) => [v.name, v]));
    for (const vmName of vmNames) {
      const vm = byName.get(vmName);
      if (!vm) {
        out.push({ vmName, running: false, status: "missing" });
      } else {
        const status = String(vm.status ?? "unknown");
        out.push({ vmName, running: status === "running", status });
      }
    }
  }
  return out;
}
