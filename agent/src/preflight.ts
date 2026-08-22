/**
 * preflight — the checks that need Proxmox credentials, run where the credentials
 * already are.
 *
 * `mt-manifest doctor` validates that the five onboarding files agree with each
 * other, but it is deliberately secret-free and cannot ask the hypervisor anything.
 * The single worst onboarding failure is exactly the kind only the hypervisor can
 * answer: `DOC_DEFAULT_STORAGE_IS_HDD` — a storage pool that resolves to a spinning
 * disk. It is silent, it wastes a whole provision plus benchmark cycle, and its cause
 * is invisible from the outside. So it belongs here.
 *
 * Everything is read-only. No VM is created, nothing is written to Proxmox.
 */

import { existsSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import {
  classifyRotational,
  proxmoxGet as probeGet,
  type DiskInfo,
  type LvmNode,
  type ProbeResult,
  type ProbeStatus,
  type ProxmoxCreds,
} from "@moltentech/protocol/proxmox-probe";
import type { AgentConfig } from "./config";

// One implementation, two callers: `mt-manifest init` runs these same checks the moment
// the operator types the token, five steps before the agent exists. Re-exported because
// this module's consumers (and its tests) already import them from here.
export { classifyRotational, type DiskInfo, type LvmNode };

export type CheckStatus = ProbeStatus;
export type CheckResult = ProbeResult;

/**
 * GET a Proxmox path using the agent's config. The transport lives in `protocol`
 * (`proxmox-probe`) so the scaffolder and the agent cannot drift on it; this is only
 * the adapter from AgentConfig to the credentials that module takes.
 */
export function proxmoxGet<T>(cfg: AgentConfig, path: string): Promise<T> {
  const creds: ProxmoxCreds = {
    url: cfg.proxmox.url ?? "",
    tokenId: cfg.proxmox.tokenId ?? "",
    tokenSecret: cfg.proxmox.tokenSecret ?? "",
  };
  return probeGet<T>(creds, path);
}

interface StorageStatus {
  storage?: string;
  type?: string;
  active?: number;
  total?: number;
}

interface StorageContent {
  volid?: string;
}

/** MANIFEST_KEY must decode to a PEM whose public half is what MT pinned. This one
 * check kills ENVFILE_NO_EXPANSION, key drift, and "docker restart didn't reload it"
 * at once, because it compares the key the container ACTUALLY loaded against the
 * pinned one — not the file on disk, not the compose entry. */
export function checkManifestKey(manifestKeyB64: string | undefined, pinnedPubkey?: string): CheckResult {
  const name = "MANIFEST_KEY decodes and matches the pinned pubkey";
  if (!manifestKeyB64) {
    return { name, status: "fail", detail: "MANIFEST_KEY is not set — the agent cannot sign to MT." };
  }
  if (manifestKeyB64.includes("$(") || manifestKeyB64.includes("${")) {
    return {
      name,
      status: "fail",
      detail:
        "MANIFEST_KEY contains a literal shell expansion — env files run no shell. " +
        "Run the base64 yourself and paste the result.",
    };
  }
  let pem: string;
  try {
    pem = Buffer.from(manifestKeyB64, "base64").toString("utf8");
  } catch {
    return { name, status: "fail", detail: "MANIFEST_KEY is not valid base64." };
  }
  if (!pem.includes("-----BEGIN")) {
    return {
      name,
      status: "fail",
      detail: "MANIFEST_KEY does not decode to a PEM — check you base64'd manifest-key.pem itself.",
    };
  }
  let derived: string;
  try {
    const pub = createPublicKey({ key: pem, format: "pem" });
    derived = pub.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  } catch (e) {
    return { name, status: "fail", detail: `MANIFEST_KEY is not a usable private key: ${(e as Error).message}` };
  }
  if (!pinnedPubkey) {
    return { name, status: "skip", detail: `decodes to pubkey ${derived} (nothing pinned locally to compare)` };
  }
  if (derived !== pinnedPubkey) {
    return {
      name,
      status: "fail",
      detail: `the loaded key's pubkey (${derived}) is NOT the pinned one (${pinnedPubkey}).`,
    };
  }
  return { name, status: "pass", detail: `matches the pinned pubkey (${derived})` };
}

export interface PreflightDeps {
  get?: typeof proxmoxGet;
}

/**
 * Run every credentialed check. Returns results rather than exiting, so the caller
 * decides (the CLI exits non-zero; a future startup hook might only warn).
 */
export async function runPreflight(
  cfg: AgentConfig,
  hosts: Array<{ nodeName: string; storageImages?: string; storageIso?: string }>,
  deps: PreflightDeps = {}
): Promise<CheckResult[]> {
  const get = deps.get ?? proxmoxGet;
  const out: CheckResult[] = [];

  // 1. Reachability + token. A 401 here is the single most common bring-up failure,
  // and PROXMOX_URL=127.0.0.1 is its most confusing form: that is the CONTAINER's
  // own loopback, not the hypervisor's.
  const proxmoxUrl = cfg.proxmox.url ?? "(PROXMOX_URL unset)";
  try {
    await get<unknown>(cfg, "/api2/json/version");
    out.push({ name: "Proxmox reachable and token accepted", status: "pass", detail: proxmoxUrl });
  } catch (e) {
    const msg = (e as Error).message;
    const hint = /127\.0\.0\.1|localhost/.test(proxmoxUrl)
      ? " — PROXMOX_URL points at loopback, which inside a container is the container itself"
      : msg.includes("401")
        ? " — token id or secret is wrong, or the token lacks permission"
        : "";
    out.push({ name: "Proxmox reachable and token accepted", status: "fail", detail: `${proxmoxUrl}: ${msg}${hint}` });
    return out; // nothing else can be checked without a working API
  }

  // 2. The CA store. Its absence reads as a middlebox or TLS problem and is neither;
  // it silently broke ArcaneOS ISO auto-refresh for weeks.
  out.push(
    process.env.NODE_EXTRA_CA_CERTS || existsSync("/etc/ssl/certs/ca-certificates.crt")
      ? { name: "CA trust store present", status: "pass", detail: "/etc/ssl/certs/ca-certificates.crt" }
      : {
          name: "CA trust store present",
          status: "fail",
          detail: "no ca-certificates in the image — outbound https will fail as 'self-signed certificate in chain'",
        }
  );

  for (const host of hosts) {
    const node = host.nodeName;
    let storages: StorageStatus[] = [];
    try {
      storages = await get<StorageStatus[]>(cfg, `/api2/json/nodes/${node}/storage`);
    } catch (e) {
      out.push({ name: `${node}: storage list`, status: "fail", detail: (e as Error).message });
      continue;
    }
    const byName = new Map(storages.filter((s) => s.storage).map((s) => [s.storage as string, s]));

    // 3. storageImages exists, is active, and is not rotational. REFUSE, don't warn:
    // a warning here costs a full provision + benchmark cycle to discover.
    const images = host.storageImages ?? cfg.host.storageImages;
    if (!images) {
      out.push({ name: `${node}: storageImages set`, status: "fail", detail: "no storage id configured" });
    } else if (!byName.has(images)) {
      out.push({
        name: `${node}: storageImages "${images}" exists`,
        status: "fail",
        detail: `not found. Available: ${[...byName.keys()].join(", ") || "(none)"}`,
      });
    } else {
      out.push({ name: `${node}: storageImages "${images}" exists`, status: "pass", detail: "active" });
      try {
        const disks = await get<DiskInfo[]>(cfg, `/api2/json/nodes/${node}/disks/list`);
        // vgname lives on the CLUSTER storage object, not the per-node status row.
        let vgname: string | undefined;
        try {
          vgname = (await get<{ vgname?: string }>(cfg, `/api2/json/storage/${images}`)).vgname;
        } catch {
          /* dir/zfs storage has no VG; the fallback heuristic covers it */
        }
        let lvmTree: LvmNode | undefined;
        try {
          lvmTree = await get<LvmNode>(cfg, `/api2/json/nodes/${node}/disks/lvm`);
        } catch {
          /* same */
        }
        const { rotational, why } = classifyRotational(disks, images, vgname, lvmTree);
        out.push({
          name: `${node}: storageImages "${images}" is not rotational`,
          status: rotational === true ? "fail" : rotational === false ? "pass" : "skip",
          detail:
            rotational === true
              ? `${why} — VMs will land on a spinning disk and benchmarks will fail with no visible cause`
              : why,
        });
      } catch (e) {
        out.push({
          name: `${node}: storageImages "${images}" is not rotational`,
          status: "skip",
          detail: `could not read the disk list: ${(e as Error).message}`,
        });
      }
    }

    // 4. storageIso exists and actually holds the named ISO.
    const iso = host.storageIso ?? cfg.host.storageIso;
    if (!iso) {
      out.push({ name: `${node}: storageIso set`, status: "fail", detail: "no ISO storage configured" });
    } else if (!byName.has(iso)) {
      out.push({
        name: `${node}: storageIso "${iso}" exists`,
        status: "fail",
        detail: `not found. Available: ${[...byName.keys()].join(", ") || "(none)"}`,
      });
    } else {
      try {
        const content = await get<StorageContent[]>(cfg, `/api2/json/nodes/${node}/storage/${iso}/content`);
        const wanted = cfg.host.arcaneIso;
        const has = content.some((c) => (c.volid ?? "").includes(wanted));
        out.push({
          name: `${node}: storageIso "${iso}" holds ${wanted}`,
          status: has ? "pass" : "fail",
          detail: has ? "present" : `${wanted} is not on ${iso} — a provision will fail at boot media`,
        });
      } catch (e) {
        out.push({ name: `${node}: storageIso "${iso}" content`, status: "skip", detail: (e as Error).message });
      }
    }
  }

  return out;
}

export function formatPreflight(results: CheckResult[]): { text: string; ok: boolean } {
  const lines = results.map((r) => {
    const mark = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "skip";
    return `${mark}  ${r.name}\n      ${r.detail}`;
  });
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  lines.push("");
  lines.push(`${results.length - failed - skipped} passed, ${failed} failed, ${skipped} indeterminate`);
  return { text: lines.join("\n"), ok: failed === 0 };
}
