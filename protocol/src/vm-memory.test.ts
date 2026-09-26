import test from "node:test";
import assert from "node:assert/strict";
import { planVmMemory, vmMemoryAdvice, HOST_RESERVE_MB } from "./vm-memory";

test("2 cumulus on a 16 GB desktop → squeezed to 7680", () => {
  const p = planVmMemory(15871, ["cumulus", "cumulus"]);
  assert.deepEqual(p?.vmMemoryMb, { cumulus: 7680 });
  assert.equal(p?.freeAtDefault, 15871 - 2 * 8192);
  assert.equal(p?.freeSqueezed, 15871 - 2 * 7680);
});

test("1 nimbus on a 32 GB host (pve50: 31999 MB) → 31744", () => {
  assert.deepEqual(planVmMemory(31999, ["nimbus"])?.vmMemoryMb, { nimbus: 31744 });
});

test("a host with room keeps the defaults", () => {
  assert.equal(planVmMemory(64221, ["cumulus"]), undefined);
  assert.equal(planVmMemory(128000, ["cumulus", "cumulus", "nimbus"]), undefined);
});

test("mixed tiers: only the tiers present are overridden", () => {
  const p = planVmMemory(40000, ["nimbus", "cumulus"]);
  assert.deepEqual(p?.vmMemoryMb, { nimbus: 31744, cumulus: 7680 });
  assert.ok((p?.freeSqueezed ?? 0) < HOST_RESERVE_MB);
});

test("no slots, or unknown tiers → nothing to suggest", () => {
  assert.equal(planVmMemory(8000, []), undefined);
  assert.equal(planVmMemory(8000, ["mystery"]), undefined);
});

test("advice: a host that keeps its reserve is a plain yes", () => {
  const a = vmMemoryAdvice("big", 34000, planVmMemory(34000, ["nimbus"])!, 1);
  assert.equal(a.defaultYes, true);
  assert.ok(!a.lines.some((l) => /KSM|swap on the SSD/.test(l)));
});

test("advice: 2 cumulus on 16 GB (pve65) → KSM + zram, still default yes", () => {
  const a = vmMemoryAdvice("pve65", 15871, planVmMemory(15871, ["cumulus", "cumulus"])!, 2);
  assert.equal(a.defaultYes, true);
  assert.match(a.lines.join("\n"), /below the ~1536 MB Proxmox itself needs\. 2 VMs share .*KSM and zram/);
  assert.match(a.lines.join("\n"), /Step 0\.6 "Small-RAM hosts"/);
});

test("advice: 1 nimbus on 32 GB (pve50) → needs SSD swap, default NO", () => {
  const a = vmMemoryAdvice("pve50", 31999, planVmMemory(31999, ["nimbus"])!, 1);
  assert.equal(a.defaultYes, false);
  assert.match(a.question, /anyway\? \(y\/N\)$/);
  assert.match(a.lines.join("\n"), /host keeps 255 MB/);
  assert.match(a.lines.join("\n"), /no help from KSM.*killed without swap.*4 GB of swap on the SSD/s);
  assert.ok(!a.lines.join("\n").includes("still tight"));
});
