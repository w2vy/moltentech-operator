import { test } from "node:test";
import assert from "node:assert/strict";
import { askHosts, type Ask, type AskUntil } from "./cli";
import { describeVm, parseKeepList, retireAdoptedMarks } from "./existing-nodes";
import { parseFluxNodeStatus } from "./flux-node-status";
import { existingNodeCandidates, qemuVms, tierForVm, REQUIRED_PRIVS, type ProxmoxSurvey } from "./proxmox-probe";
import { renderInventoryJson, type Answers, type HostAnswer } from "./scaffold";
import { InventoryHost } from "./messages";

const GiB = 1024 ** 3;
// Measured on pve40 2026-09-23: an ArcaneOS cumulus VM lists 4 cpus, 8 GiB, 220 GiB.
const cumulusRow = { vmid: 104, name: "flux-node-1", status: "running", cpus: 4, maxmem: 8 * GiB, maxdisk: 220 * GiB };

test("tier sizing matches arcane-mage's TIER_CONFIG, largest tier first", () => {
  assert.equal(tierForVm({ cpus: 4, maxmem: 8 * GiB, maxdisk: 220 * GiB }), "cumulus");
  assert.equal(tierForVm({ cpus: 8, maxmem: 32 * GiB, maxdisk: 440 * GiB }), "nimbus");
  assert.equal(tierForVm({ cpus: 16, maxmem: 64 * GiB, maxdisk: 880 * GiB }), "stratus");
  assert.equal(tierForVm({ cpus: 16, maxmem: 64 * GiB, maxdisk: 300 * GiB }), "cumulus", "disk caps it");
  assert.equal(tierForVm({ cpus: 2, maxmem: 8 * GiB, maxdisk: 220 * GiB }), undefined);
});

test("candidates skip undersized, already-declared and hub-built VMs", () => {
  const vms = qemuVms([
    cumulusRow,
    { vmid: "105", name: "mt-184-c2", cpus: 4, maxmem: 8 * GiB, maxdisk: 220 * GiB },
    { vmid: 106, name: "fh-mt-184-c7", cpus: 4, maxmem: 8 * GiB, maxdisk: 220 * GiB, tags: "cumulus;flux-hub;foundation" },
    { vmid: 126, name: "desktop", cpus: 2, maxmem: 8 * GiB, maxdisk: 128 * GiB },
    { name: "no-vmid" },
  ]);
  assert.equal(vms.length, 4, "a row with no VMID is dropped");
  const got = existingNodeCandidates(vms, new Set(["mt-184-c2"]));
  assert.deepEqual(got.map((c) => [c.vm.vmid, c.tier]), [[104, "cumulus"]]);
  assert.match(describeVm(vms[0]!), /^104 flux-node-1 · running · 4c\/8 GB\/220 GB → cumulus\?$/);
});

test("the probe's privilege check covers listing and renaming", () => {
  assert.ok(REQUIRED_PRIVS.includes("VM.Audit"));
  assert.ok(REQUIRED_PRIVS.includes("VM.Config.Options"));
});

test("getfluxnodestatus: parsed from the shapes measured on prod", () => {
  const txid = "dc68c94765b5db32482f10aef6a135e12ab9dc48bc8edae8916d2bb5c9ce51cc";
  const base = { status: "CONFIRMED", tier: "CUMULUS", txhash: txid, outidx: "0" };
  assert.deepEqual(parseFluxNodeStatus({ status: "success", data: { ...base, ip: "47.206.56.185" } }), {
    status: "CONFIRMED",
    tier: "cumulus",
    ip: "47.206.56.185",
    apiPort: 16127,
    collateral: { txid, vout: 0 },
  });
  const nonDefault = parseFluxNodeStatus({ status: "success", data: { ...base, ip: "47.206.56.184:16197" } });
  assert.equal(nonDefault?.ip, "47.206.56.184");
  assert.equal(nonDefault?.apiPort, 16197);
});

test("getfluxnodestatus: a starting daemon or junk is null, a bad outpoint is omitted", () => {
  assert.equal(parseFluxNodeStatus({ status: "error", data: { code: -28, message: "Loading block index..." } }), null);
  assert.equal(parseFluxNodeStatus("nope"), null);
  const noTx = parseFluxNodeStatus({ status: "success", data: { status: "STARTED", ip: "1.2.3.4", txhash: "", outidx: "0" } });
  assert.equal(noTx?.collateral, undefined);
  assert.equal(noTx?.tier, undefined);
});

test("keep list: VMIDs on the host, in order, 'none' = nothing", () => {
  const vms = qemuVms([cumulusRow, { vmid: 107, name: "flux-node-2" }]);
  assert.deepEqual(parseKeepList("none", vms), []);
  assert.deepEqual((parseKeepList("107, 104, 107", vms) as { vmid: number }[]).map((v) => v.vmid), [107, 104]);
  assert.match(parseKeepList("999", vms) as string, /not a VMID on this host/);
});

const slot = (vmName: string, existingVm?: { vmid: number; name: string }) => ({
  tier: "cumulus",
  vmName,
  ipAddress: "47.206.56.184",
  lanIp: "192.168.184.9/24",
  gateway: "192.168.184.1",
  apiPort: 16197,
  ...(existingVm ? { existingVm } : {}),
});

test("a mark is retired once Adopt renamed the VM, or the VM is gone; kept when unknown", () => {
  const hosts: HostAnswer[] = [
    {
      name: "pve40",
      storageImages: "local-lvm",
      storageIso: "local",
      slots: [
        slot("mt-184-c9", { vmid: 104, name: "flux-node-1" }),
        slot("mt-184-c8", { vmid: 105, name: "flux-node-2" }),
        slot("mt-184-c7", { vmid: 106, name: "flux-node-3" }),
      ],
    },
  ];
  const listing = { pve40: qemuVms([{ vmid: 104, name: "mt-184-c9" }, { vmid: 106, name: "flux-node-3" }]) };
  const { hosts: out, notes } = retireAdoptedMarks(hosts, listing);
  assert.deepEqual(out[0]!.slots.map((s) => s.existingVm?.vmid), [undefined, undefined, 106]);
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /adopted/);
  assert.match(notes[1]!, /no longer on pve40/);
  assert.deepEqual(retireAdoptedMarks(hosts, undefined).hosts, hosts, "no listing: keep every mark");
});

test("inventory.json carries existingVm, and the agent's schema keeps it", () => {
  const a = {
    hosts: [{ name: "pve40", storageImages: "local-lvm", storageIso: "local", slots: [slot("mt-184-c9", { vmid: 104, name: "flux-node-1" })] }],
  } as unknown as Answers;
  const parsed = InventoryHost.array().parse(JSON.parse(renderInventoryJson(a)));
  assert.deepEqual(parsed[0]!.slots[0]!.existingVm, { vmid: 104, name: "flux-node-1" });
});

/** Answer prompts by pattern; anything unmatched takes its default. */
function scripted(rules: Array<[RegExp, string]>): { ask: Ask; askUntil: AskUntil; asked: string[] } {
  const asked: string[] = [];
  const answer = (q: string, def?: string) => {
    asked.push(q);
    if (asked.length > 200) throw new Error(`prompt loop at "${q}"`);
    const hit = rules.find(([re]) => re.test(q));
    return hit ? hit[1] : def ?? "";
  };
  const ask: Ask = async (q, def) => answer(q, def);
  const askUntil: AskUntil = async (q, problem, def) => {
    const a = answer(q, def);
    const p = await problem(a);
    if (p) throw new Error(`prompt "${q}" refused "${a}": ${p}`);
    return a;
  };
  return { ask, askUntil, asked };
}

const hub = { check: async () => null, blocking: async () => undefined, advise: () => {} };

test("askHosts: a picked existing VM becomes a marked slot, pre-filled from FluxOS on the WAN", async () => {
  const survey: ProxmoxSurvey = {
    nodes: ["pve40"],
    storages: {},
    vms: { pve40: qemuVms([cumulusRow, { vmid: 200, name: "w2vy", cpus: 2, maxmem: 16 * GiB, maxdisk: 180 * GiB }]) },
  };
  const probed: string[] = [];
  const { ask, askUntil } = scripted([
    [/host name/, "pve40"],
    [/storage pool for VM images/, "local-lvm"],
    [/ArcaneOS ISO/, "local"],
    [/which are Flux nodes/, "104"],
    [/how many node slots/, "1"],
    [/^\s*WAN IP/, "47.206.56.184"],
    [/LAN gateway/, "192.168.184.1/24"],
    [/Flux API port/, "16197"],
    [/VM name suffix/, "184-c9"],
    [/LAN address/, "9"],
  ]);
  const txid = "fe44a38dfb958e35f41722e7c7fccc66eb1d95f7b12623c9fdee287ef842cb1b";
  const hosts = await askHosts(ask, askUntil, {
    prefix: "mt-",
    tiers: [],
    minimums: { cumulus: 250, nimbus: 700, stratus: 1400 },
    survey,
    hub,
    nodeStatus: async (ip, port) => {
      probed.push(`${ip}:${port}`);
      return { status: "CONFIRMED", tier: "cumulus", ip, apiPort: port, collateral: { txid, vout: 0 } };
    },
  });
  assert.deepEqual(probed, ["47.206.56.184:16197"], "probed on the WAN, never the LAN");
  const s = hosts[0]!.slots[0]!;
  assert.equal(s.vmName, "mt-184-c9");
  assert.deepEqual(s.existingVm, { vmid: 104, name: "flux-node-1", collateral: { txid, vout: 0 } });
});

test("askHosts: 'none' for the existing VM leaves an ordinary new slot", async () => {
  const survey: ProxmoxSurvey = { nodes: ["pve40"], storages: {}, vms: { pve40: qemuVms([cumulusRow]) } };
  const { ask, askUntil, asked } = scripted([
    [/host name/, "pve40"],
    [/storage pool for VM images/, "local-lvm"],
    [/ArcaneOS ISO/, "local"],
    [/which are Flux nodes/, "none"],
    [/how many node slots/, "1"],
    [/^\s*WAN IP/, "47.206.56.184"],
    [/LAN gateway/, "192.168.184.1/24"],
    [/Flux API port/, "16197"],
    [/VM name suffix/, "184-c9"],
    [/LAN address/, "9"],
  ]);
  const hosts = await askHosts(ask, askUntil, {
    prefix: "mt-",
    tiers: [],
    minimums: { cumulus: 250 },
    survey,
    hub,
    nodeStatus: async () => assert.fail("no existing VM, no probe"),
  });
  assert.equal(hosts[0]!.slots[0]!.existingVm, undefined);
  assert.ok(!asked.some((q) => /existing VM on this slot/.test(q)), "not asked when nothing is kept");
});

test("askHosts re-run: Enter all the way keeps an existing mark", async () => {
  const survey: ProxmoxSurvey = { nodes: ["pve40"], storages: {}, vms: { pve40: qemuVms([cumulusRow]) } };
  const current: HostAnswer[] = [
    { name: "pve40", storageImages: "local-lvm", storageIso: "local", slots: [slot("mt-184-c9", { vmid: 104, name: "flux-node-1" })] },
  ];
  const { ask, askUntil } = scripted([]);
  const hosts = await askHosts(ask, askUntil, {
    prefix: "mt-",
    tiers: [],
    minimums: { cumulus: 250 },
    survey,
    hub,
    current,
    nodeStatus: async () => null,
  });
  assert.deepEqual(hosts[0]!.slots.map((s) => [s.vmName, s.existingVm]), [["mt-184-c9", { vmid: 104, name: "flux-node-1" }]]);
});
