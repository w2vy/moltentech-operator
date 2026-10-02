import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "./config";
import { ensureDatedIso, isDatedFluxLiveIso, newestFluxLiveIso } from "./iso-name";

const PROXMOX = { url: "https://pve:8006", tokenId: "t", tokenSecret: "s" };
function cfg(arcaneIso: string, proxmox: unknown = PROXMOX): AgentConfig {
  return { host: { arcaneIso, storageIso: "local" }, proxmox } as unknown as AgentConfig;
}

test("dated = FluxLive-<10 digits>.iso, exactly what arcane-mage's iso_name pattern accepts", () => {
  assert.ok(isDatedFluxLiveIso("FluxLive-1775071308.iso"));
  for (const bad of ["FluxLive.iso", "FluxLive-111.iso", "FluxLive-17750713080.iso", "fluxlive-1775071308.iso", "", undefined, null]) {
    assert.ok(!isDatedFluxLiveIso(bad), String(bad));
  }
});

test("newest = highest build stamp among dated names; others ignored", () => {
  assert.equal(newestFluxLiveIso(["ubuntu.iso", "FluxLive-1775071308.iso", "FluxLive-1769000000.iso", "FluxLive.iso"]), "FluxLive-1775071308.iso");
  assert.equal(newestFluxLiveIso(["ubuntu.iso", "FluxLive.iso"]), null);
  assert.equal(newestFluxLiveIso([]), null);
});

test("a dated name is kept without touching Proxmox", async () => {
  const c = cfg("FluxLive-1775071308.iso");
  let calls = 0;
  assert.equal(await ensureDatedIso(c, "pve30", "shared", async () => (calls++, [])), "FluxLive-1775071308.iso");
  assert.equal(calls, 0);
});

test("MT-0091: a bare FluxLive.iso is replaced by the newest dated ISO on the storage, read via the job's node", async () => {
  const c = cfg("FluxLive.iso");
  const seen: string[] = [];
  const got = await ensureDatedIso(c, "pve30", "pve55-shared", async (_c, node, storage) => {
    seen.push(`${node}/${storage}`);
    return ["FluxLive-1769000000.iso", "FluxLive-1775071308.iso"];
  });
  assert.equal(got, "FluxLive-1775071308.iso");
  assert.equal(c.host.arcaneIso, "FluxLive-1775071308.iso", "adopted for the rest of this run");
  assert.deepEqual(seen, ["pve30/pve55-shared"]);
});

test("best-effort: no dated ISO, an unreadable storage, or no creds leave the name as it was", async () => {
  const none = cfg("FluxLive.iso");
  assert.equal(await ensureDatedIso(none, "pve30", "s", async () => ["FluxLive.iso"]), "FluxLive.iso");
  const broken = cfg("FluxLive.iso");
  assert.equal(await ensureDatedIso(broken, "pve30", "s", async () => { throw new Error("proxmox 500"); }), "FluxLive.iso");
  const nocreds = cfg("FluxLive.iso", {});
  let calls = 0;
  assert.equal(await ensureDatedIso(nocreds, "pve30", "s", async () => (calls++, ["FluxLive-1775071308.iso"])), "FluxLive.iso");
  assert.equal(calls, 0);
});
