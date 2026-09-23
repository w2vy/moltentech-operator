import { test } from "node:test";
import assert from "node:assert/strict";
import { InventoryHost, type Job } from "@moltentech/protocol";
import { existingVmFence, existingVmFor, planRename, toListing } from "./existing-vm";

const mark = { vmid: 104, name: "flux-node-1" };

const hosts = [
  InventoryHost.parse({
    name: "pve40",
    nodeName: "pve40",
    slots: [
      {
        tier: "cumulus",
        vmName: "mt-184-c9",
        ipAddress: "47.206.56.184",
        gateway: "192.168.184.1",
        apiPort: 16197,
        existingVm: mark,
      },
      { tier: "cumulus", vmName: "mt-184-c8", ipAddress: "47.206.56.184", gateway: "192.168.184.1", apiPort: 16187 },
    ],
  }),
];

function job(action: Job["action"], extra: Partial<Job> = {}): Job {
  return {
    schemaVersion: 1,
    jobId: "job-1",
    providerSlug: "moltentech",
    action,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    slot: { vmName: "mt-184-c9", nodeName: "pve40" },
    ...extra,
  } as unknown as Job;
}

test("the inventory schema keeps existingVm (the agent strips unknown fields)", () => {
  assert.deepEqual(hosts[0]!.slots[0]!.existingVm, mark);
});

test("existingVmFor matches by node and slot name, and only marked slots", () => {
  assert.deepEqual(existingVmFor(hosts, "pve40", "mt-184-c9"), mark);
  assert.equal(existingVmFor(hosts, "pve40", "mt-184-c8"), undefined);
  assert.equal(existingVmFor(hosts, "pve20", "mt-184-c9"), undefined);
});

test("fence refuses provision, reprovision and move while the marked VM is present", () => {
  const listing = toListing([{ vmid: 104, name: "flux-node-1" }]);
  for (const a of ["provision", "reprovision", "move"] as const) {
    const r = existingVmFence(job(a), mark, listing);
    assert.equal(r?.failureClass, "permanent", a);
    assert.match(r!.message, /adopt it on \/operator\/fleet/);
  }
});

test("fence lifts once the marked VMID is gone from the host", () => {
  assert.equal(existingVmFence(job("provision"), mark, toListing([{ vmid: 105, name: "other" }])), null);
});

test("fence refuses transient when the listing failed — never guess 'gone'", () => {
  assert.equal(existingVmFence(job("provision"), mark, null)?.failureClass, "transient");
});

test("fence ignores unmarked slots and non-building actions", () => {
  assert.equal(existingVmFence(job("provision"), undefined, null), null);
  assert.equal(existingVmFence(job("delete"), mark, null), null);
  assert.equal(existingVmFence(job("rename"), mark, null), null);
});

const renameJob = (from = "flux-node-1", vmid = 104) => job("rename", { rename: { vmid, from } });

test("rename renames the declared VM", () => {
  assert.deepEqual(planRename(renameJob(), mark, toListing([{ vmid: 104, name: "flux-node-1" }])), {
    kind: "rename",
    vmid: 104,
  });
});

test("rename is idempotent: already named = done", () => {
  assert.deepEqual(planRename(renameJob(), mark, toListing([{ vmid: "104", name: "mt-184-c9" }])), { kind: "done" });
});

test("rename refuses a VM the operator did not declare (fence 3)", () => {
  const listing = toListing([{ vmid: 104, name: "flux-node-1" }, { vmid: 200, name: "w2vy" }]);
  const wrongId = planRename(renameJob("w2vy", 200), mark, listing);
  assert.ok("ok" in wrongId && wrongId.failureClass === "permanent");
  const wrongName = planRename(renameJob("desktop"), mark, listing);
  assert.ok("ok" in wrongName && /does not match/.test(wrongName.message));
  const unmarked = planRename(renameJob(), undefined, listing);
  assert.ok("ok" in unmarked && /renames only VMs you declared/.test(unmarked.message));
});

test("rename refuses when the VM drifted, vanished, or the name is taken", () => {
  const drifted = planRename(renameJob(), mark, toListing([{ vmid: 104, name: "renamed-by-hand" }]));
  assert.ok("ok" in drifted && /not flux-node-1/.test(drifted.message));
  const gone = planRename(renameJob(), mark, toListing([]));
  assert.ok("ok" in gone && /not on node/.test(gone.message));
  const taken = planRename(
    renameJob(),
    mark,
    toListing([
      { vmid: 104, name: "flux-node-1" },
      { vmid: 300, name: "mt-184-c9" },
    ])
  );
  assert.ok("ok" in taken && /already named mt-184-c9/.test(taken.message));
  const unknown = planRename(renameJob(), mark, null);
  assert.ok("ok" in unknown && unknown.failureClass === "transient");
});
