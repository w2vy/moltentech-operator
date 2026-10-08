import { test } from "node:test";
import assert from "node:assert/strict";
import { declaresAnySlot } from "./config";
import type { InventoryHost } from "@moltentech/protocol";

// The hub refuses an inventory assert that declares no slots. Staging 2026-10-08: cute-dogs,
// freshly onboarded with one host and `slots: []`, drew that 400 every cycle.

const host = (slots: InventoryHost["slots"]): InventoryHost =>
  ({ name: "pve45", nodeName: "pve45", network: "vmbr0", storageImages: "ssd", storageIso: "local", slots }) as InventoryHost;

const slot = {
  tier: "cumulus",
  vmName: "cd-187c3",
  ipAddress: "47.206.56.187",
  lanIp: "192.168.87.3/24",
  gateway: "192.168.87.1",
  apiPort: 16137,
} as InventoryHost["slots"][number];

test("no hosts: nothing to assert", () => {
  assert.equal(declaresAnySlot([]), false);
});

test("⭐ hosts with `slots: []` only: nothing to assert (the cute-dogs 400)", () => {
  assert.equal(declaresAnySlot([host([])]), false);
  assert.equal(declaresAnySlot([host([]), host([])]), false);
});

test("one slot anywhere: assert", () => {
  assert.equal(declaresAnySlot([host([slot])]), true);
  assert.equal(declaresAnySlot([host([]), host([slot])]), true);
});
