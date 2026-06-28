import { SCHEMA_VERSION } from "@moltentech/protocol";
import { loadConfig } from "./config";
import { MtClient } from "./client";
import { pickExecutor } from "./executor";
import { collectHealth } from "./health";

/**
 * Operator agent main loop. Outbound-only: it pulls jobs and pushes results +
 * listing to MoltenTech; nothing connects in. Holds the local Proxmox creds.
 */
async function main() {
  const cfg = loadConfig();
  const client = new MtClient(cfg.mtBaseUrl, cfg.agentKey).withProvider(cfg.providerSlug);
  const executor = pickExecutor(cfg);

  console.log(
    `[agent] provider=${cfg.providerSlug} mt=${cfg.mtBaseUrl} dryRun=${cfg.dryRun} ` +
      `poll=${cfg.pollIntervalMs}ms listing=${cfg.listingIntervalMs}ms`
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

  await reassertListing();
  await reportHealthOnce();
  const listingTimer = setInterval(reassertListing, cfg.listingIntervalMs);
  const healthTimer = setInterval(reportHealthOnce, cfg.healthIntervalMs);

  while (!stopping) {
    await pollOnce();
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
  clearInterval(listingTimer);
  clearInterval(healthTimer);
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
