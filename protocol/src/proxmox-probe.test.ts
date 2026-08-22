import { test } from "node:test";
import assert from "node:assert/strict";
import {
  probeProxmox,
  explainProxmoxError,
  classifyRotational,
  ssdImageStorages,
  isoStorages,
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
      { storage: "pve55-shared", type: "nfs", content: "iso,vztmpl" },
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

test("only non-spinning image storages are offered; ISO storages ignore rotation", async () => {
  const probe = await probeProxmox(CREDS, fakeGet());
  const options = probe.survey!.storages["pve30"]!;
  assert.deepEqual(ssdImageStorages(options).map((o) => o.id), ["ssd"]);
  assert.deepEqual(isoStorages(options).map((o) => o.id), ["pve55-shared"]);
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
    ssdImageStorages([{ id: "x", type: "dir", rotational: null, why: "", content: ["images"] }]),
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

test("an authenticating token that sees no node is a failure, not an empty pass", async () => {
  const probe = await probeProxmox(CREDS, fakeGet({ "/api2/json/nodes": [] }));
  assert.equal(probe.ok, false);
  assert.match(probe.checks.find((c) => c.name.includes("nodes"))!.detail, /sees no node/);
});
