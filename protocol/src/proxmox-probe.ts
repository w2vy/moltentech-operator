/**
 * Proxmox probe — the checks that need the operator's API token, in a form both the
 * scaffolder and the agent can run.
 *
 * ## Why this is in `protocol`
 *
 * The token is created in Step 0.1 of onboarding and, until now, first exercised in
 * Step 6 by `mt-agent doctor` — five steps and a Docker image later. An operator who
 * mistyped the secret, or scoped the token to a path (which cannot work: VM.Allocate is
 * checked on /vms or /pool, and the tooling passes neither), found out long after the
 * moment that produced it.
 *
 * `mt-manifest init` now asks for the token, so it can prove it there and then — and
 * reuse the same connection to offer the operator their real node and storage names
 * instead of asking them to transcribe them.
 *
 * The implementation is the agent's, moved rather than copied: `agent/src/preflight.ts`
 * imports `proxmoxGet` and `classifyRotational` from here. Two implementations of "does
 * this storage spin?" would be one too many — that question has already been answered
 * wrong once, in production, by a `local-lvm` default sitting on a WD Red.
 *
 * Everything here is READ-ONLY: it lists, it never creates. It is also opt-in — the
 * file-level `doctor` holds no credentials and reaches no network unless asked
 * (`--check-proxmox`), the same line `--check-stripe` draws.
 */

import https from "node:https";

/** Proxmox self-signs by default; there is no CA to check against on a LAN hypervisor,
 * and refusing here would mean refusing every real deployment. */
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

export interface ProxmoxCreds {
  /** Base URL including the port, e.g. `https://pve30:8006`. */
  url: string;
  /** e.g. `fluxhub@pve!agent` */
  tokenId: string;
  tokenSecret: string;
}

export type ProbeStatus = "pass" | "fail" | "skip";

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  detail: string;
}

/**
 * GET a Proxmox path, surfacing the status code and separating the failure modes that
 * look identical from the outside: a wrong token (401), a privilege the role lacks
 * (403), a wrong storage id (404), a host that is not there (ECONNREFUSED), and — the
 * one that bites inside a container — a name that does not resolve.
 */
export function proxmoxGet<T>(creds: ProxmoxCreds, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${creds.url}${path}`);
    const req = https.request(
      url,
      {
        method: "GET",
        agent: insecureAgent,
        headers: { Authorization: `PVEAPIToken=${creds.tokenId}=${creds.tokenSecret}` },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            resolve((JSON.parse(data).data ?? []) as T);
          } catch (e) {
            reject(e as Error);
          }
        });
      }
    );
    req.on("error", (e) => reject(e));
    req.setTimeout(10_000, () => req.destroy(new Error("timed out after 10s")));
    req.end();
  });
}

export interface LvmNode {
  name?: string;
  children?: LvmNode[];
}

export interface DiskInfo {
  devpath?: string;
  type?: string;
  /** ⚠️ Proxmox returns this as a STRING for spinning disks ("5400") and the number 0
   * for solid state. Coerce before comparing, or every HDD reads as 0 rpm. */
  rpm?: number | string;
}

/**
 * Resolve a storage id to its physical media and decide whether it spins.
 *
 * `DOC_DEFAULT_STORAGE_IS_HDD` is the worst failure in the onboarding set: silent,
 * costs a full provision plus benchmark cycle, and reports no cause. Proxmox does not
 * expose rotational-ness on the storage object, so this walks the real chain:
 *
 *   storage id --vgname--> LVM volume group --children--> /dev/sdaN --> disk rpm/type
 *
 * Verified against pve30, the host that proved the failure: `ssd` -> VG `ssd` ->
 * /dev/sdb (WD Blue SSD, rpm 0) and `local-lvm` -> VG `pve` -> /dev/sda3 -> /dev/sda
 * (WD Red, rpm 5400). Returns null only when the chain genuinely cannot be followed —
 * an honest "cannot tell" beats a confident wrong answer here.
 */
export function classifyRotational(
  disks: DiskInfo[],
  storageName: string,
  vgname?: string,
  lvmTree?: LvmNode
): { rotational: boolean | null; why: string } {
  const spins = (d: DiskInfo): boolean => Number(d.rpm ?? 0) > 0 || d.type === "hdd";

  // Preferred path: follow vgname through the LVM tree to the actual PVs.
  const vg = vgname ? (lvmTree?.children ?? []).find((c) => c.name === vgname) : undefined;
  if (vg) {
    const pvPaths = (vg.children ?? []).map((c) => c.name ?? "").filter(Boolean);
    // A PV is a PARTITION (/dev/sda3); the disk list reports whole devices (/dev/sda).
    const backing = disks.filter((d) => (d.devpath ? pvPaths.some((pv) => pv.startsWith(d.devpath!)) : false));
    if (backing.length > 0) {
      const spinning = backing.filter(spins);
      if (spinning.length > 0) {
        return {
          rotational: true,
          why: `${storageName} -> VG ${vgname} -> ${spinning.map((d) => d.devpath).join(", ")} (rotational)`,
        };
      }
      return {
        rotational: false,
        why: `${storageName} -> VG ${vgname} -> ${backing.map((d) => d.devpath).join(", ")} (solid state)`,
      };
    }
  }

  // Fallback: no VG mapping available (dir/zfs storage, or an API that did not answer).
  const spinning = disks.filter(spins);
  if (spinning.length === 0) return { rotational: false, why: "no rotational devices reported on this node" };
  const named = spinning.find((d) => (d.devpath ?? "").includes(storageName));
  if (named) return { rotational: true, why: `${storageName} matches spinning device ${named.devpath}` };
  if (disks.length > 0 && spinning.length === disks.length) {
    return { rotational: true, why: "every device on this node is rotational" };
  }
  return {
    rotational: null,
    why: `node has both spinning and solid-state devices; could not resolve "${storageName}" to one of them`,
  };
}

/** One storage id, with everything the operator needs to choose between them. */
export interface StorageOption {
  id: string;
  type: string;
  /** true = spins, false = solid state, null = could not be resolved. */
  rotational: boolean | null;
  why: string;
  /** What Proxmox says it can hold: `images`, `iso`, `vztmpl`, ... */
  content: string[];
  /**
   * The same bytes on every node. For ISO storage this is the answer you WANT: the agent
   * stages the ArcaneOS ISO once and the whole cluster sees it, instead of a copy per host
   * that each have to be refreshed.
   */
  shared: boolean;
  /**
   * Usable from THIS node right now. Proxmox lists cluster-wide storages on every node's
   * storage endpoint whether or not they are reachable there, which is why a fleet full of
   * per-host VGs shows up on each host as a list of storages it cannot actually use.
   */
  active: boolean;
}

export interface ProxmoxSurvey {
  nodes: string[];
  /** Node name -> its storages. */
  storages: Record<string, StorageOption[]>;
}

interface NodeRow {
  node?: string;
}
interface StorageRow {
  storage?: string;
  type?: string;
  content?: string;
  /** 1 = the same bytes are visible from every node in the cluster. */
  shared?: number;
  /** 0 = defined cluster-wide but not usable from THIS node right now. */
  active?: number;
  enabled?: number;
}

/**
 * Explain a connection failure in the operator's terms.
 *
 * ⚠️ The `mt-manifest` wrapper runs the container on Docker's default bridge, so a
 * hostname is resolved by the CONTAINER, not by the shell that typed it. `pve30` works
 * on the host and fails inside — and reporting that as "token invalid" sends the
 * operator to regenerate a credential that was never wrong.
 */
/** `127.0.0.0/8` or IPv6 `::1` — inside a container these are the container itself. */
function isLoopbackAddress(addr: string): boolean {
  return /^127\./.test(addr) || addr === "::1";
}

export function explainProxmoxError(err: Error, url: string): string {
  const msg = err.message;
  if (/EAI_AGAIN|ENOTFOUND|getaddrinfo/i.test(msg)) {
    return (
      `cannot resolve the hostname in ${url}. Inside a container, names resolve in the ` +
      `CONTAINER — use an IP address, or a name this container can resolve. The token is not implicated.`
    );
  }
  // The name resolved, but to a loopback address — which the URL string alone cannot
  // show. Debian maps a bare hostname to `127.0.1.1` in /etc/hosts, so mounting the
  // host's /etc/hosts to make names resolve can hand the container an address that
  // points back at ITSELF. Left to the generic ECONNREFUSED text below this reads as a
  // wrong port, and the operator changes the one thing that was right.
  const addr = (err as Error & { address?: string }).address;
  if (addr && isLoopbackAddress(addr)) {
    return (
      `the name in ${url} resolved to ${addr}, which inside a container is the CONTAINER, ` +
      `not the hypervisor. Its /etc/hosts maps that name to loopback — use the ` +
      `hypervisor's LAN IP in the URL. The token is not implicated.`
    );
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return `${url} refused the connection — wrong port, or Proxmox is not listening there.`;
  }
  if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) {
    return (
      `no route to ${url} from inside this container. The name resolved, so the address ` +
      `is probably right and the network is not: check that this host can reach the ` +
      `hypervisor's LAN. The token is not implicated.`
    );
  }
  if (/timed out/i.test(msg)) {
    return `${url} did not answer within 10s — usually a firewall or a wrong address.`;
  }
  if (/127\.0\.0\.1|localhost/.test(url)) {
    return `${url} is loopback, which inside a container is the container itself, not the hypervisor.`;
  }
  if (msg.includes("401")) return "the token id or secret is wrong (401).";
  if (msg.includes("403")) return "the token authenticated but lacks permission (403).";
  return msg;
}

export interface ProxmoxProbe {
  ok: boolean;
  checks: ProbeResult[];
  survey?: ProxmoxSurvey;
}

/** The privileges the agent uses on every provision. `Datastore.AllocateSpace` is the
 * one a hand-built role most often lacks, and its absence looks like a broken image
 * import rather than a permission. */
export const REQUIRED_PRIVS = [
  "VM.Allocate",
  "VM.Config.Disk",
  "VM.Config.Network",
  "VM.PowerMgmt",
  "Datastore.AllocateSpace",
  "Sys.Audit",
];

/**
 * Connect, prove the token, prove the privileges the agent actually needs, and list
 * what is there.
 *
 * The privilege check reads `/access/permissions`, which is what the token can see
 * about ITSELF — no guessing, and it names the missing privilege rather than leaving a
 * 403 to surface inside a provision months later.
 */
export async function probeProxmox(
  creds: ProxmoxCreds,
  get: typeof proxmoxGet = proxmoxGet
): Promise<ProxmoxProbe> {
  const checks: ProbeResult[] = [];

  try {
    await get<unknown>(creds, "/api2/json/version");
    checks.push({ name: "Proxmox reachable and token accepted", status: "pass", detail: creds.url });
  } catch (e) {
    checks.push({
      name: "Proxmox reachable and token accepted",
      status: "fail",
      detail: explainProxmoxError(e as Error, creds.url),
    });
    return { ok: false, checks }; // nothing else is knowable without a working API
  }

  try {
    const perms = await get<Record<string, Record<string, number>>>(creds, "/api2/json/access/permissions");
    const atRoot = perms["/"] ?? {};
    const missing = REQUIRED_PRIVS.filter((p) => !atRoot[p]);
    checks.push(
      missing.length === 0
        ? {
            name: "token holds the privileges the agent needs",
            status: "pass",
            detail: `${REQUIRED_PRIVS.length} checked at /`,
          }
        : {
            name: "token holds the privileges the agent needs",
            status: "fail",
            detail:
              `missing at /: ${missing.join(", ")}. Add them with ` +
              `\`pveum role modify FluxHubAgent -privs "${REQUIRED_PRIVS.join(",")}"\` ` +
              `rather than escalating the token to PVEAdmin.`,
          }
    );
  } catch (e) {
    // A path-scoped token is the usual reason this read fails, and that is itself the
    // finding: VM.Allocate is checked on /vms or /pool, so a /nodes-scoped token cannot
    // provision no matter what it lists.
    checks.push({
      name: "token holds the privileges the agent needs",
      status: "skip",
      detail:
        `could not read /access/permissions (${(e as Error).message}) — if this token is ` +
        `PATH-SCOPED, that is the problem: scope it cluster-wide.`,
    });
  }

  const survey: ProxmoxSurvey = { nodes: [], storages: {} };
  try {
    const nodes = await get<NodeRow[]>(creds, "/api2/json/nodes");
    survey.nodes = nodes
      .map((n) => n.node ?? "")
      .filter(Boolean)
      .sort();
    checks.push({
      name: "cluster nodes visible",
      status: survey.nodes.length > 0 ? "pass" : "fail",
      detail: survey.nodes.join(", ") || "none — the token can authenticate but sees no node",
    });
  } catch (e) {
    checks.push({ name: "cluster nodes visible", status: "fail", detail: (e as Error).message });
    return { ok: false, checks, survey };
  }

  for (const node of survey.nodes) {
    try {
      const rows = await get<StorageRow[]>(creds, `/api2/json/nodes/${node}/storage`);
      const disks = await get<DiskInfo[]>(creds, `/api2/json/nodes/${node}/disks/list`).catch(
        () => [] as DiskInfo[]
      );
      const lvmTree = await get<LvmNode>(creds, `/api2/json/nodes/${node}/disks/lvm`).catch(() => undefined);
      const options: StorageOption[] = [];
      for (const row of rows) {
        const id = row.storage;
        if (!id) continue;
        // vgname lives on the CLUSTER storage object, not the per-node status row.
        const vgname = await get<{ vgname?: string }>(creds, `/api2/json/storage/${id}`)
          .then((s) => s.vgname)
          .catch(() => undefined);
        const { rotational, why } = classifyRotational(disks, id, vgname, lvmTree);
        options.push({
          id,
          type: row.type ?? "",
          rotational,
          why,
          content: (row.content ?? "").split(",").filter(Boolean),
          shared: row.shared === 1,
          // Absent means the field was not reported; treat that as usable rather than
          // hiding a storage on a Proxmox version that does not send it.
          active: row.active !== 0 && row.enabled !== 0,
        });
      }
      survey.storages[node] = options;
    } catch (e) {
      checks.push({ name: `${node}: storage list`, status: "fail", detail: (e as Error).message });
    }
  }

  return { ok: !checks.some((c) => c.status === "fail"), checks, survey };
}

/** Storages that can hold VM disks and are known NOT to spin — the safe answers to
 * "storage pool for VM images". A `null` (unresolved) storage is deliberately NOT
 * offered: this list exists to make the silent-benchmark-failure unpickable. */
export function ssdImageStorages(options: StorageOption[]): StorageOption[] {
  return options.filter((o) => o.active && o.content.includes("images") && o.rotational === false);
}

/**
 * Storages that can hold ISOs, SHARED ONES FIRST.
 *
 * Rotational is irrelevant — an ISO is read once at boot. What matters is whether the
 * cluster shares it: the agent refreshes the ArcaneOS ISO onto the storage each declared
 * host names, so a shared NFS/CIFS target is staged once and every node sees the new
 * release, while per-host storage means N copies and N chances for one host to be left on
 * a stale ISO. Ordering is the recommendation — the wizard offers `[0]` as its default.
 */
export function isoStorages(options: StorageOption[]): StorageOption[] {
  return options
    .filter((o) => o.active && o.content.includes("iso"))
    .sort((a, b) => Number(b.shared) - Number(a.shared));
}

/**
 * How to label a storage in a one-line list.
 *
 * "?" used to be the answer for everything whose media could not be resolved through LVM
 * — which on a real cluster is most of them: NFS, CIFS, dir-backed, and every per-host VG
 * belonging to a DIFFERENT host. That reads as "the tool is broken", when in fact the
 * media question is the wrong question for a network share, and a storage that is not
 * active here is not a choice at all.
 */
export function describeStorage(o: StorageOption): string {
  if (!o.active) return "elsewhere in the cluster";
  if (o.rotational === true) return "HDD";
  if (o.rotational === false) return "SSD";
  // A network storage has no local spindle to classify; its type IS the useful answer,
  // and `shared` is what decides whether it is the right ISO target.
  if (o.shared) return `${o.type.toUpperCase()}, shared`;
  return o.type ? o.type : "?";
}

export function formatProbe(checks: ProbeResult[]): string {
  const icon: Record<ProbeStatus, string> = { pass: "+", fail: "x", skip: "-" };
  return checks.map((c) => `  ${icon[c.status]} ${c.name}: ${c.detail}`).join("\n");
}
