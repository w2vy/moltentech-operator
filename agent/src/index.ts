import { SCHEMA_VERSION } from "@moltentech/protocol";
import { verifyOwnerAuth } from "@moltentech/protocol/wallet";
import { loadConfig, reloadInventory } from "./config";
import { MtClient, type MtClientAuth } from "./client";
import { CoalitionClient } from "./coalition-client";
import { loadManifestKey } from "./signing";
import { pickExecutor } from "./executor";
import { collectHealth } from "./health";

/**
 * Operator agent main loop. Outbound-only: it pulls jobs and pushes results +
 * listing to MoltenTech; nothing connects in. Holds the local Proxmox creds.
 */
async function main() {
  const cfg = loadConfig();
  const manifestKey = loadManifestKey(cfg.manifestKey);
  const auth: MtClientAuth = manifestKey
    ? { kind: "signature", key: manifestKey }
    : { kind: "bearer", agentKey: cfg.agentKey! };
  const client = new MtClient(cfg.mtBaseUrl, auth).withProvider(cfg.providerSlug);
  const executor = pickExecutor(cfg);

  // WS3 courier: relay owner authorizations via the operator's own Coalition
  // console. Needs the manifest key (to auth to the coalition), the coalition URL,
  // and a pinned owner (to pre-filter signatures). Absent any → courier disabled.
  const coalition =
    manifestKey && cfg.coalitionUrl && cfg.ownerAddress
      ? new CoalitionClient(cfg.coalitionUrl, manifestKey, cfg.providerSlug)
      : undefined;

  console.log(
    `[agent] provider=${cfg.providerSlug} mt=${cfg.mtBaseUrl} auth=${auth.kind} ` +
      `ownerAuth=${cfg.ownerAddress ? "enforced" : "off"} courier=${coalition ? "on" : "off"} ` +
      `dryRun=${cfg.dryRun} poll=${cfg.pollIntervalMs}ms listing=${cfg.listingIntervalMs}ms`
  );

  let stopping = false;
  const stop = () => {
    stopping = true;
    console.log("[agent] shutting down…");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  async function pollOnce() {
    let jobs;
    try {
      jobs = await client.claimJobs();
    } catch (err) {
      console.error("[agent] claim error:", (err as Error).message);
      return;
    }
    for (const job of jobs) {
      let result;
      try {
        const r = await executor(job, cfg);
        result = { ok: r.ok, message: r.message, vmId: r.vmId };
      } catch (err) {
        result = { ok: false, message: (err as Error).message };
      }
      try {
        await client.postResult({
          schemaVersion: SCHEMA_VERSION,
          jobId: job.jobId,
          status: result.ok ? "success" : "failed",
          message: result.message,
          vmId: result.vmId,
        });
        console.log(`[agent] job ${job.jobId} (${job.action}) -> ${result.ok ? "success" : "failed"}`);
      } catch (err) {
        // Lease will expire and the job becomes reclaimable; just log.
        console.error(`[agent] result post failed for ${job.jobId}:`, (err as Error).message);
      }
    }
  }

  async function reassertListing() {
    if (cfg.listing.length === 0) return;
    try {
      await client.assertListing(cfg.listing);
    } catch (err) {
      console.error("[agent] listing assert error:", (err as Error).message);
    }
  }

  async function reassertInventory() {
    const inventory = reloadInventory(cfg); // re-read the file so console edits propagate
    if (inventory.length === 0) return;
    try {
      await client.assertInventory(inventory);
      const slots = inventory.reduce((n, h) => n + h.slots.length, 0);
      console.log(`[agent] declared inventory: ${inventory.length} host(s), ${slots} slot(s)`);
    } catch (err) {
      console.error("[agent] inventory assert error:", (err as Error).message);
    }
  }

  // Courier: fetch pending authorizations from MT → push to the coalition console
  // for the operator to sign → poll the signed blobs → verify locally → relay to MT.
  async function courierOnce() {
    if (!coalition || !cfg.ownerAddress) return;
    // Dashboard state snapshot — isolated from the auth flow so one can't break the other.
    try {
      await coalition.pushState(await client.getState());
    } catch (err) {
      console.error("[agent] state push error:", (err as Error).message);
    }
    try {
      await coalition.pushPending(await client.getPendingAuth());
      const signed = await coalition.pollAuthorizations();
      for (const { slotId, ownerAuth } of signed) {
        const decision = verifyOwnerAuth(ownerAuth, cfg.ownerAddress);
        if (!decision.ok) {
          console.error(`[agent] rejected authorization for ${ownerAuth.vmName}: ${decision.reason}`);
          continue;
        }
        await client.submitAuthorize(slotId, ownerAuth);
        console.log(`[agent] relayed authorization: ${ownerAuth.action} ${ownerAuth.vmName}`);
      }
    } catch (err) {
      console.error("[agent] courier error:", (err as Error).message);
    }
  }

  // Run both cadences; simple self-scheduling loops with their own intervals.
  async function reportHealthOnce() {
    if (cfg.dryRun) return; // no local Proxmox to query in dry-run
    try {
      const owned = await client.getNodes();
      if (owned.length === 0) return;
      const health = await collectHealth(cfg, owned);
      if (health.length > 0) {
        await client.reportHealth(health);
        console.log(`[agent] reported health for ${health.length} node(s)`);
      }
    } catch (err) {
      console.error("[agent] health report error:", (err as Error).message);
    }
  }

  // Declare inventory first so the host/slot rows exist before listing + health.
  await reassertInventory();
  await reassertListing();
  await reportHealthOnce();
  await courierOnce();
  const inventoryTimer = setInterval(reassertInventory, cfg.listingIntervalMs);
  const listingTimer = setInterval(reassertListing, cfg.listingIntervalMs);
  const healthTimer = setInterval(reportHealthOnce, cfg.healthIntervalMs);
  const courierTimer = setInterval(courierOnce, cfg.listingIntervalMs);

  while (!stopping) {
    await pollOnce();
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
  clearInterval(inventoryTimer);
  clearInterval(listingTimer);
  clearInterval(healthTimer);
  clearInterval(courierTimer);
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
