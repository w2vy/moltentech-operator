import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "./config";
import type { IsoRefreshResult } from "./executor";
import { refreshIsoOnce } from "./iso-refresh";

const baseHost: AgentConfig["host"] = {
  network: "vmbr0",
  storageImages: "local-lvm",
  storageIso: "local",
  storageImport: "local",
  arcaneIso: "FluxLive-111.iso",
  sshPubkey: "",
  consoleHash: "!",
};

function cfgWith(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    host: { ...baseHost },
    inventory: [],
    dryRun: false,
    ...overrides,
  } as unknown as AgentConfig;
}

test("dry-run skips ISO refresh entirely", async () => {
  const cfg = cfgWith({ dryRun: true, inventory: [{ name: "h1", nodeName: "pve1", slots: [] }] as never });
  let calls = 0;
  await refreshIsoOnce(cfg, async () => {
    calls++;
    return { ok: true };
  });
  assert.equal(calls, 0);
});

test("no declared inventory skips ISO refresh (no known node to target)", async () => {
  const cfg = cfgWith({ inventory: [] });
  let calls = 0;
  await refreshIsoOnce(cfg, async () => {
    calls++;
    return { ok: true };
  });
  assert.equal(calls, 0);
});

test("checks every declared host, falling back to cfg.host.storageIso when unset", async () => {
  const cfg = cfgWith({
    inventory: [
      { name: "h1", nodeName: "pve1", storageIso: "fast-nvme", slots: [] },
      { name: "h2", nodeName: "pve2", slots: [] },
    ] as never,
  });
  const seen: Array<[string, string]> = [];
  await refreshIsoOnce(cfg, async (node, storageIso) => {
    seen.push([node, storageIso]);
    return { ok: true, changed: false, iso: cfg.host.arcaneIso };
  });
  assert.deepEqual(seen, [
    ["pve1", "fast-nvme"],
    ["pve2", "local"],
  ]);
});

test("adopts the new ISO name into cfg.host.arcaneIso once staged, for the next provision", async () => {
  const cfg = cfgWith({ inventory: [{ name: "h1", nodeName: "pve1", slots: [] }] as never });
  const result: IsoRefreshResult = { ok: true, changed: true, iso: "FluxLive-222.iso", build: "222", severity: "medium" };
  await refreshIsoOnce(cfg, async () => result);
  assert.equal(cfg.host.arcaneIso, "FluxLive-222.iso");
});

test("passes the current ISO through for reporting, and does not adopt on failure", async () => {
  const cfg = cfgWith({ inventory: [{ name: "h1", nodeName: "pve1", slots: [] }] as never });
  let receivedCurrentIso: string | undefined;
  await refreshIsoOnce(cfg, async (_node, _storageIso, currentIso) => {
    receivedCurrentIso = currentIso;
    return { ok: false, error: "boom" };
  });
  assert.equal(receivedCurrentIso, "FluxLive-111.iso");
  assert.equal(cfg.host.arcaneIso, "FluxLive-111.iso"); // unchanged on failure
});

test("one host's failure does not stop the others, and a later success still adopts", async () => {
  const cfg = cfgWith({
    inventory: [
      { name: "h1", nodeName: "pve1", slots: [] },
      { name: "h2", nodeName: "pve2", slots: [] },
    ] as never,
  });
  await refreshIsoOnce(cfg, async (node) => {
    if (node === "pve1") return { ok: false, error: "unreachable" };
    return { ok: true, changed: true, iso: "FluxLive-333.iso" };
  });
  assert.equal(cfg.host.arcaneIso, "FluxLive-333.iso");
});

test("a thrown error from the refresh call does not crash the loop", async () => {
  const cfg = cfgWith({ inventory: [{ name: "h1", nodeName: "pve1", slots: [] }] as never });
  await assert.doesNotReject(
    refreshIsoOnce(cfg, async () => {
      throw new Error("network exploded");
    })
  );
  assert.equal(cfg.host.arcaneIso, "FluxLive-111.iso"); // unchanged
});
