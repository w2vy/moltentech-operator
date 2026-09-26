import test from "node:test";
import assert from "node:assert/strict";
import { planVmMemory, HOST_RESERVE_MB } from "./vm-memory";

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
