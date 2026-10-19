import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeHealth } from "@moltentech/protocol";
import { ownedVmsForNode, toNodeHealth } from "./health";

// The hub turns two `netIn` readings into a download rate, so the agent forwards the raw counter.

test("a running VM's netin counter rides through to the health report", () => {
  const vm = ownedVmsForNode("pve3", ["gcn-pve3-1"], [
    { name: "gcn-pve3-1", status: "running", vmid: 107, netin: 52_428_800_000 },
  ])[0]!;
  const h = toNodeHealth(vm);
  assert.deepEqual(h, { vmName: "gcn-pve3-1", running: true, status: "running", netIn: 52_428_800_000 });
  assert.ok(NodeHealth.safeParse(h).success);
});

test("a stopped VM reports no netIn — its 0 would read as a counter reset", () => {
  const vm = ownedVmsForNode("pve3", ["gcn-pve3-1"], [{ name: "gcn-pve3-1", status: "stopped", vmid: 107, netin: 0 }])[0]!;
  assert.deepEqual(toNodeHealth(vm), { vmName: "gcn-pve3-1", running: false, status: "stopped" });
});

test("a missing VM, or a listing with no usable netin, reports no netIn", () => {
  const missing = ownedVmsForNode("pve3", ["gcn-pve3-2"], [])[0]!;
  assert.equal("netIn" in toNodeHealth(missing), false);
  for (const netin of [undefined, -1, 1.5, Number.NaN]) {
    const vm = ownedVmsForNode("pve3", ["gcn-pve3-1"], [{ name: "gcn-pve3-1", status: "running", netin }])[0]!;
    assert.equal(vm.netIn, null, `netin ${netin}`);
    assert.equal("netIn" in toNodeHealth(vm), false);
  }
});

test("a health report from an older agent (no netIn) still parses", () => {
  assert.ok(NodeHealth.safeParse({ vmName: "x", running: true, status: "running" }).success);
  assert.equal(NodeHealth.safeParse({ vmName: "x", running: true, status: "running", netIn: -5 }).success, false);
});
