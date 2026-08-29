import { test } from "node:test";
import assert from "node:assert/strict";
import {
  probeProxmox,
  explainProxmoxError,
  classifyRotational,
  ssdImageStorages,
  isoStorages,
  describeStorage,
  REQUIRED_PRIVS,
  type ProxmoxCreds,
} from "./proxmox-probe";

/**
 * The probe exists to move three failures from "discovered five steps later, in a
 * different tool" to "discovered the moment the token is typed":
 *
 *   1. the token is wrong             — a 401 that used to read as a bring-up mystery
 *   2. the token is path-scoped       — cannot provision, no matter what it lists
 *   3. the image storage SPINS        — silent; costs a provision + benchmark cycle
 *
 * The transport is injected, so these assert the JUDGEMENT, not the network.
 */

const CREDS: ProxmoxCreds = { url: "https://pve30:8006", tokenId: "fluxhub@pve!agent", tokenSecret: "s" };

const ALL_PRIVS = {
  "/": {
    "VM.Allocate": 1,
    "VM.Config.Disk": 1,
    "VM.Config.Network": 1,
    "VM.PowerMgmt": 1,
    "Datastore.AllocateSpace": 1,
    "Sys.Audit": 1,
    // On PVE 8+ these are what make a bridge VISIBLE. Without them the network list is
    // filtered rather than refused, so a provision fails with "Network not present on
    // hypervisor" against a bridge that is up and correct.
    "SDN.Use": 1,
    "SDN.Audit": 1,
  },
};

/** A hypervisor whose `ssd` storage is solid state and whose `local-lvm` is a WD Red —
 * the exact shape of the host that produced DOC_DEFAULT_STORAGE_IS_HDD. */
function fakeGet(overrides: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    "/api2/json/version": { version: "8.2" },
    "/api2/json/access/permissions": ALL_PRIVS,
    "/api2/json/nodes": [{ node: "pve30" }],
    "/api2/json/nodes/pve30/storage": [
      { storage: "ssd", type: "lvmthin", content: "images,rootdir" },
      { storage: "local-lvm", type: "lvmthin", content: "images,rootdir" },
      { storage: "pve55-shared", type: "nfs", content: "iso,vztmpl", shared: 1, active: 1 },
      { storage: "local", type: "dir", content: "iso,vztmpl", shared: 0, active: 1 },
      // Defined cluster-wide, belongs to another host: Proxmox lists it here anyway.
      { storage: "ss8", type: "lvmthin", content: "images", shared: 0, active: 0 },
    ],
    "/api2/json/nodes/pve30/disks/list": [
      { devpath: "/dev/sda", type: "hdd", rpm: "5400" },
      { devpath: "/dev/sdb", type: "ssd", rpm: 0 },
    ],
    "/api2/json/nodes/pve30/disks/lvm": {
      children: [
        { name: "pve", children: [{ name: "/dev/sda3" }] },
        { name: "ssd", children: [{ name: "/dev/sdb" }] },
      ],
    },
    "/api2/json/storage/ssd": { vgname: "ssd" },
    "/api2/json/storage/local-lvm": { vgname: "pve" },
    "/api2/json/storage/pve55-shared": {},
    // The probe now EXERCISES a read instead of trusting /access/permissions. A healthy
    // hypervisor answers this; the 2026-08-29 host returned 403 here while reporting every
    // Datastore privilege about itself.
    "/api2/json/nodes/pve30/storage/pve55-shared/content": [
      { volid: "pve55-shared:iso/FluxLive-1775071308.iso", format: "iso" },
    ],
    ...overrides,
  };
  return async <T>(_c: ProxmoxCreds, path: string): Promise<T> => {
    const hit = routes[path];
    if (hit instanceof Error) throw hit;
    if (hit === undefined) throw new Error("HTTP 404");
    return hit as T;
  };
}

test("a wrong token fails at the first call and stops — nothing else is knowable", async () => {
  const probe = await probeProxmox(CREDS, fakeGet({ "/api2/json/version": new Error("HTTP 401") }));
  assert.equal(probe.ok, false);
  assert.equal(probe.checks.length, 1, "no point probing privileges with a rejected token");
  assert.match(probe.checks[0]!.detail, /token id or secret is wrong \(401\)/);
});

test("⭐ a missing privilege is NAMED, with the pveum line that fixes it", async () => {
  const partial = { "/": { ...ALL_PRIVS["/"], "Datastore.AllocateSpace": 0 } };
  const probe = await probeProxmox(CREDS, fakeGet({ "/api2/json/access/permissions": partial }));
  const check = probe.checks.find((c) => c.name.includes("privileges"))!;
  assert.equal(check.status, "fail");
  assert.match(check.detail, /missing at \/: Datastore\.AllocateSpace/);
  assert.match(check.detail, /pveum role modify FluxHubAgent/);
  assert.doesNotMatch(check.detail, /PVEAdmin["' ]*$/, "never suggest escalating as the fix");
});

test("a path-scoped token cannot read its own permissions — say THAT, not 'unknown'", async () => {
  const probe = await probeProxmox(
    CREDS,
    fakeGet({ "/api2/json/access/permissions": new Error("HTTP 403") })
  );
  const check = probe.checks.find((c) => c.name.includes("privileges"))!;
  assert.equal(check.status, "skip");
  assert.match(check.detail, /PATH-SCOPED/);
});

test("⭐ the survey resolves each storage to its real media", async () => {
  const probe = await probeProxmox(CREDS, fakeGet());
  assert.equal(probe.ok, true);
  const byId = new Map(probe.survey!.storages["pve30"]!.map((o) => [o.id, o]));
  assert.equal(byId.get("ssd")!.rotational, false);
  assert.equal(byId.get("local-lvm")!.rotational, true, "VG pve sits on the WD Red");
  assert.match(byId.get("local-lvm")!.why, /\/dev\/sda/);
});

test("only non-spinning image storages are offered; ISO storages put SHARED first", async () => {
  const probe = await probeProxmox(CREDS, fakeGet());
  const options = probe.survey!.storages["pve30"]!;
  assert.deepEqual(ssdImageStorages(options).map((o) => o.id), ["ssd"]);
  // ⭐ Shared first, because that is the recommendation the wizard defaults to: the agent
  // stages the ArcaneOS ISO onto whatever each host names, so a shared target is refreshed
  // ONCE for the cluster while `local` is a copy per host to keep current.
  assert.deepEqual(isoStorages(options).map((o) => o.id), ["pve55-shared", "local"]);
});

test("⭐ a storage that belongs to ANOTHER host is not offered, and says so", async () => {
  // Proxmox lists cluster-wide storages on every node whether or not they are reachable
  // there, so a fleet of per-host VGs shows up on each host as storages it cannot use.
  // Labelling those "?" reads as a broken tool; they are simply not choices here.
  const probe = await probeProxmox(CREDS, fakeGet());
  const options = probe.survey!.storages["pve30"]!;
  const elsewhere = options.find((o) => o.id === "ss8")!;
  assert.equal(elsewhere.active, false);
  assert.equal(describeStorage(elsewhere), "elsewhere in the cluster");
  assert.equal(ssdImageStorages(options).some((o) => o.id === "ss8"), false);
});

test("a network share is labelled by what it IS, not as an unresolved disk", () => {
  // "Does it spin?" is the wrong question for NFS, and "?" is the wrong answer to it.
  const nfs = { id: "pve55-shared", type: "nfs", rotational: null, why: "", content: ["iso"], shared: true, active: true };
  assert.equal(describeStorage(nfs), "NFS, shared");
  assert.equal(describeStorage({ ...nfs, type: "cifs" }), "CIFS, shared");
  assert.equal(describeStorage({ ...nfs, shared: false, type: "dir" }), "dir");
  assert.equal(describeStorage({ ...nfs, rotational: false }), "SSD", "resolved media still wins");
});

test("a storage that cannot be resolved is NOT offered as safe", () => {
  // Mixed media, no VG mapping: the honest answer is null, and null must not be picked
  // for the operator — the offer list exists to make the wrong choice unpickable.
  const { rotational } = classifyRotational(
    [
      { devpath: "/dev/sda", type: "hdd", rpm: "7200" },
      { devpath: "/dev/sdb", type: "ssd", rpm: 0 },
    ],
    "some-dir-storage"
  );
  assert.equal(rotational, null);
  assert.deepEqual(
    ssdImageStorages([
      { id: "x", type: "dir", rotational: null, why: "", content: ["images"], shared: false, active: true },
    ]),
    []
  );
});

test("⭐ a name the container cannot resolve does not read as a bad token", () => {
  const detail = explainProxmoxError(new Error("getaddrinfo EAI_AGAIN pve30"), "https://pve30:8006");
  assert.match(detail, /resolve/);
  assert.match(detail, /token is not implicated/);
});

test("loopback is explained as the container's own loopback", () => {
  const detail = explainProxmoxError(new Error("connect ECONNREFUSED 127.0.0.1:8006"), "https://127.0.0.1:8006");
  assert.match(detail, /refused|container itself/);
});

test("⭐ a NAME that resolved to loopback is named as such, not blamed on the port", () => {
  // The trap that mounting the host's /etc/hosts introduces: Debian maps a bare hostname
  // to 127.0.1.1, so the URL string looks nothing like loopback while the address is.
  const err = Object.assign(new Error("connect ECONNREFUSED 127.0.1.1:8006"), { address: "127.0.1.1" });
  const detail = explainProxmoxError(err, "https://pve50:8006");
  assert.match(detail, /127\.0\.1\.1/);
  assert.match(detail, /CONTAINER/);
  assert.match(detail, /token is not implicated/);
  assert.doesNotMatch(detail, /wrong port/);
});

test("a real ECONNREFUSED against a LAN address still reads as a port problem", () => {
  const err = Object.assign(new Error("connect ECONNREFUSED 192.168.102.50:8006"), { address: "192.168.102.50" });
  assert.match(explainProxmoxError(err, "https://pve50:8006"), /wrong port/);
});

test("an authenticating token that sees no node is a failure, not an empty pass", async () => {
  const probe = await probeProxmox(CREDS, fakeGet({ "/api2/json/nodes": [] }));
  assert.equal(probe.ok, false);
  assert.match(probe.checks.find((c) => c.name.includes("nodes"))!.detail, /sees no node/);
});

// ── The 2026-08-29 pve50 incident: five attempts, three distinct causes ────────────────
// Each of these asserts a check that would have named a cause BEFORE the first provision.

test("⭐ a token that reports every privilege but reads no storage FAILS", async () => {
  // The exact shape measured on pve50: /access/permissions returned the complete
  // Datastore.* set (pvedaemon had a stale ACL after the node left its cluster), while
  // /nodes/<node>/storage returned `200 {"data":[]}` — no error to catch. Before this the
  // probe reported a clean pass and the wizard simply offered no storage options.
  const probe = await probeProxmox(CREDS, fakeGet({ "/api2/json/nodes/pve30/storage": [] }));
  assert.equal(probe.ok, false, "an empty storage list is a permission result, not an empty host");
  const check = probe.checks.find((c) => c.name.includes("storage readable"))!;
  assert.equal(check.status, "fail");
  // Must contradict the passing privilege line above it, or the two together are confusing.
  assert.match(check.detail, /asks the token about itself/);
  // And name the fix that actually worked.
  assert.match(check.detail, /restart pvedaemon pveproxy/);
});

test("⭐ privileges claimed but a storage read that 403s is caught by the exercised check", async () => {
  const probe = await probeProxmox(
    CREDS,
    fakeGet({ "/api2/json/nodes/pve30/storage/pve55-shared/content": new Error("HTTP 403") })
  );
  assert.equal(probe.ok, false);
  const priv = probe.checks.find((c) => c.name.includes("privileges"))!;
  const read = probe.checks.find((c) => c.name.includes("storage readable"))!;
  assert.equal(priv.status, "pass", "the self-report still passes — that is the whole point");
  assert.match(priv.detail, /self-reported/);
  assert.equal(read.status, "fail", "the exercised read is what catches it");
});

test("⭐ SDN privileges are required — a bridge is invisible without them", async () => {
  // Not a hypothetical: PVEAdmin carries SDN.* incidentally, so every provision on the
  // reference fleet passed while the documented least-privilege role could not see vmbr0.
  assert.ok(REQUIRED_PRIVS.includes("SDN.Use"));
  assert.ok(REQUIRED_PRIVS.includes("SDN.Audit"));
  const probe = await probeProxmox(
    CREDS,
    fakeGet({
      "/api2/json/access/permissions": {
        "/": { "VM.Allocate": 1, "VM.Config.Disk": 1, "VM.Config.Network": 1, "VM.PowerMgmt": 1, "Datastore.AllocateSpace": 1, "Sys.Audit": 1 },
      },
    })
  );
  const priv = probe.checks.find((c) => c.name.includes("privileges"))!;
  assert.equal(priv.status, "fail");
  assert.match(priv.detail, /SDN\.Use/);
  assert.match(priv.detail, /SDN\.Audit/);
});

test("a healthy hypervisor reports the storage it read, so a pass is legible", async () => {
  const probe = await probeProxmox(CREDS, fakeGet());
  const read = probe.checks.find((c) => c.name.includes("storage readable"))!;
  assert.equal(read.status, "pass");
  assert.match(read.detail, /pve55-shared/);
});
