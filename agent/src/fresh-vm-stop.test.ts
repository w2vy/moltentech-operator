import { test } from "node:test";
import assert from "node:assert/strict";
import { FRESH_VM_UPTIME_S, hardStopIfFresh, isFreshRunningVm, type FreshStopDeps } from "./fresh-vm-stop";
import type { Vm } from "./health";

function deps(vms: Vm[], over: Partial<FreshStopDeps> = {}) {
  const calls: string[] = [];
  const d: FreshStopDeps = {
    list: async () => vms,
    stop: async (node, vmid) => {
      calls.push(`stop ${node} ${vmid}`);
      return "UPID:pve50:1";
    },
    task: async () => ({ status: "stopped", exitstatus: "OK" }),
    sleep: async () => {},
    ...over,
  };
  return { d, calls };
}

test("fresh = running and up less than ten minutes; unknown uptime is not fresh", () => {
  assert.equal(isFreshRunningVm({ status: "running", uptime: 40 }), true);
  assert.equal(isFreshRunningVm({ status: "running", uptime: FRESH_VM_UPTIME_S - 1 }), true);
  assert.equal(isFreshRunningVm({ status: "running", uptime: FRESH_VM_UPTIME_S }), false);
  assert.equal(isFreshRunningVm({ status: "stopped", uptime: 0 }), false);
  assert.equal(isFreshRunningVm({ status: "running" }), false);
});

test("a fresh running VM is hard-stopped and the job log says why", async () => {
  const { d, calls } = deps([{ name: "mt2-183-c6", vmid: "109", status: "running", uptime: 40 }]);
  const note = await hardStopIfFresh("mt2-183-c6", "pve50", d);
  assert.deepEqual(calls, ["stop pve50 109"]);
  assert.match(note ?? "", /Fresh VM mt2-183-c6 \(id=109, up 40 s.*hard-stopped, no graceful shutdown/);
});

test("an older running VM keeps the graceful shutdown: nothing is stopped", async () => {
  const { d, calls } = deps([{ name: "mt-184-c4", vmid: 120, status: "running", uptime: 86_400 }]);
  assert.equal(await hardStopIfFresh("mt-184-c4", "pve50", d), null);
  assert.deepEqual(calls, []);
});

test("missing VM or a failed listing: nothing done, arcane-mage handles it as before", async () => {
  assert.equal(await hardStopIfFresh("gone", "pve50", deps([]).d), null);
  const broken = deps([], { list: async () => Promise.reject(new Error("proxmox 500")) });
  assert.equal(await hardStopIfFresh("x", "pve50", broken.d), null);
});

test("a stop that fails or never finishes is logged; the graceful path still follows", async () => {
  const vm: Vm = { name: "v", vmid: 7, status: "running", uptime: 10 };
  const refused = deps([vm], { stop: async () => Promise.reject(new Error("proxmox 403: no VM.PowerMgmt")) });
  assert.match((await hardStopIfFresh("v", "n", refused.d)) ?? "", /hard stop failed \(proxmox 403/);
  const slow = deps([vm], { task: async () => ({ status: "running" }) });
  assert.match((await hardStopIfFresh("v", "n", slow.d)) ?? "", /still running after 30 s/);
  const bad = deps([vm], { task: async () => ({ status: "stopped", exitstatus: "VM quit failed" }) });
  assert.match((await hardStopIfFresh("v", "n", bad.d)) ?? "", /ended VM quit failed/);
});
