import { SCHEMA_VERSION } from "@moltentech/protocol";
import { verifyOwnerAuth } from "@moltentech/protocol/wallet";
import { loadConfig, reloadInventory, reloadLoanOfferDeclarations } from "./config";
import { MtClient, type MtClientAuth } from "./client";
import { CoalitionClient } from "./coalition-client";
import { loadManifestKey } from "./signing";
import { pickExecutor, deprovisionVm } from "./executor";
import { collectOwnedVms, type OwnedVm } from "./health";
import { shouldSelfDestruct } from "./trial-expiry";
import { logLoanScan, overConcurrencyLimit, scanLoans } from "./loan-scan";
import { buildLoanOffers } from "./loan-offer";
import { reclaimPlan } from "./loan-reclaim";
import { refreshIsoOnce } from "./iso-refresh";
import { runDetached } from "./background";
import { runPreflight, formatPreflight, checkManifestKey } from "./preflight";

/**
 * Operator agent main loop. Outbound-only: it pulls jobs and pushes results +
 * listing to MoltenTech; nothing connects in. Holds the local Proxmox creds.
 */
/**
 * `mt-agent doctor` — the credentialed half of onboarding validation.
 *
 * `mt-manifest doctor` checks that the five config files agree with each other, but it
 * is deliberately secret-free and cannot ask the hypervisor anything. These checks need
 * the Proxmox token, which lives HERE and nowhere else. Read-only: no VM is created.
 *
 * Runs to completion and exits non-zero on any failure, so it works as a bring-up gate
 * before the first provision rather than after a wasted benchmark cycle.
 */
async function doctor(): Promise<never> {
  const cfg = loadConfig();
  const hosts = reloadInventory(cfg);
  console.log(`mt-agent doctor — provider=${cfg.providerSlug} proxmox=${cfg.proxmox.url}\n`);

  const results = await runPreflight(
    cfg,
    hosts.map((h) => ({ nodeName: h.nodeName, storageImages: h.storageImages, storageIso: h.storageIso }))
  );
  // Compares the key the process ACTUALLY loaded, which is what makes it catch the
  // "docker restart didn't reload it" class rather than just re-reading a file.
  results.push(checkManifestKey(cfg.manifestKey, process.env.MANIFEST_PUBKEY));

  const { text, ok } = formatPreflight(results);
  console.log(text);
  if (hosts.length === 0) {
    console.log("\nnote: no declared inventory — only the hypervisor-wide checks ran.");
  }
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (process.argv[2] === "doctor") return doctor();
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
        result = { ok: r.ok, message: r.message, vmId: r.vmId, failureClass: r.failureClass };
      } catch (err) {
        // An exception escaping the executor is an agent-side fault of unknown
        // nature — left unclassified so MT never auto-retries it.
        result = { ok: false, message: (err as Error).message, failureClass: undefined };
      }
      try {
        await client.postResult({
          schemaVersion: SCHEMA_VERSION,
          jobId: job.jobId,
          status: result.ok ? "success" : "failed",
          message: result.message,
          vmId: result.vmId,
          failureClass: result.failureClass,
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
      // ONE Proxmox listing, two consumers: the health report the hub gets, and the local trial
      // sweep below. `tags` rides along in the same response, so the sweep costs no extra call.
      const vms = await collectOwnedVms(cfg, owned);
      const health = vms.map(({ vmName, status }) => ({
        vmName,
        running: status === "running",
        status,
      }));
      if (health.length > 0) {
        await client.reportHealth(health);
        console.log(`[agent] reported health for ${health.length} node(s)`);
      }
      // After the report, never before: a self-destruct that threw must not cost the hub its
      // health update, and the hub finding out via the next poll's `missing` is the whole
      // reconciliation design.
      await sweepExpiredTrials(vms);
      await scanLoansOnce(vms);
    } catch (err) {
      console.error("[agent] health report error:", (err as Error).message);
    }
  }

  /**
   * liskov — destroy owned VMs whose own Proxmox tag says their trial term has ended.
   *
   * 🔒 **Owned VMs only** (fence 3). `vms` comes from `getNodes()`, i.e. this provider's slots as
   * declared in `inventory.json`, so a VM the agent does not manage is never a candidate whatever
   * its tags say — an operator's own unrelated VM cannot be reached even if one happens to carry
   * a `free` chip.
   *
   * The decision itself is `shouldSelfDestruct`, which holds every other fence and is pure. This
   * function is the I/O around it, and it logs UNCONDITIONALLY on a destroy: no job row and no
   * hub record exists for an autonomous destroy, so this line is the operator's only trace of it.
   *
   * Never throws: it runs inside the health cadence, which must not gate the poll loop (#90).
   */
  async function sweepExpiredTrials(vms: OwnedVm[]) {
    const now = new Date();
    for (const vm of vms) {
      if (vm.status === "missing") continue; // nothing to destroy
      const verdict = shouldSelfDestruct(vm.tags, now);
      if (!verdict.destroy) {
        // `not-free` and `too-stale` mean a VM carries a deadline the fences refused to act on —
        // a stamp-builder bug or a bad clock, either way something a human should see. The other
        // reasons are the overwhelmingly common no-op and stay silent.
        if (verdict.reason === "not-free" || verdict.reason === "too-stale") {
          console.warn(
            `[trial-expiry] ${vm.vmName} on ${vm.nodeName}: REFUSING to destroy (${verdict.reason}) ` +
              `tags=${vm.tags.join(";")}`
          );
        }
        continue;
      }
      console.log(
        `[trial-expiry] ${vm.vmName} on ${vm.nodeName}: trial term ended — destroying. ` +
          `tags=${vm.tags.join(";")} deadline=${verdict.deadline.toISOString()} now=${now.toISOString()}`
      );
      try {
        const r = await deprovisionVm(vm.vmName, vm.nodeName, cfg);
        console.log(
          `[trial-expiry] ${vm.vmName}: ${r.ok ? "destroyed" : "FAILED"} — ${(r.message ?? "").slice(0, 500)}`
        );
      } catch (err) {
        // Idempotent by construction: the VM is still there, so the next cycle tries again.
        console.error(`[trial-expiry] ${vm.vmName}: destroy threw — ${(err as Error).message}`);
      }
    }
  }

  /**
   * lamport §9d.3 — recover this lender's loan state from its own hypervisor.
   *
   * Rides the health cadence and reuses its listing, the same way the trial sweep does: the
   * `leased` chip arrives free on that listing, so an operator who lends nothing pays nothing.
   *
   * ⛔ Reads and reports only. Nothing here deletes a VM — §7 step 5 is a separate change,
   * because an agent-originated delete has no `checkOwnerAuth` behind it.
   *
   * Never throws: like the trial sweep it runs inside the health cadence, which must not gate
   * the poll loop (#90).
   */
  async function scanLoansOnce(vms: OwnedVm[]) {
    const declarations = reloadLoanOfferDeclarations(cfg);
    const leased = vms.some((v) => v.tags.includes("leased"));
    if (declarations.length === 0 && !leased) return;

    // Build the offers from the operator's declarations against their OWN inventory. The
    // unsigned build is what the lender's own scan uses — a local file is trusted for being
    // local (§7 step 1); the signature is for the copy that leaves the box.
    const { offers, refused } = buildLoanOffers(
      declarations,
      reloadInventory(cfg),
      cfg.providerSlug,
      new Date()
    );
    for (const { declaration, reason } of refused) {
      // Loud and per-declaration: a refused offer is a slot the operator BELIEVES is on loan
      // and which nothing will ever honour. Silence here is the worst outcome.
      console.warn(
        `[loan] offer refused (${reason}): ${declaration.vmName} on ${declaration.nodeName} ` +
          `to ${declaration.borrowerSlug} rev${declaration.revision}`
      );
    }
    try {
      const results = await scanLoans(cfg, vms, offers, new Date());
      logLoanScan(results);

      const breaches = overConcurrencyLimit(results);
      for (const { borrowerSlug, count } of breaches) {
        // The hub enforces this at request ingest too. Both firing is the design; only this one
        // firing means the hub's copy failed, and the loans are already running.
        console.warn(
          `[loan] ${borrowerSlug} holds ${count} of this lender's slots at once — over the ` +
            `per-pair limit. The hub's ingest check should have refused this. No loan of theirs ` +
            `will be reclaimed automatically until this is resolved.`
        );
      }
      await reclaimExpiredLoans(results, new Set(breaches.map((b) => b.borrowerSlug)));
    } catch (err) {
      console.error("[loan] scan error:", (err as Error).message);
    }
  }

  /**
   * §7 step 5 — destroy a borrowed VM whose term has run out.
   *
   * ⚠️ The ONE autonomous delete in the loan design. No hub job, no operator signature, no
   * `ProvisionLog` row, no second party of any kind — and the node belongs to the BORROWER's
   * paying customer. Every fence lives in `readLoanState` (loan-state.ts) and `shouldReclaim`
   * (loan-reclaim.ts), both pure and both tested without a hypervisor; this function does the
   * I/O and nothing else.
   *
   * Logs UNCONDITIONALLY on a delete, for the same reason the trial sweep does: there is no
   * record of it anywhere else, so this line is the operator's only trace.
   *
   * `expiry = delete`. There is no stop and no grace (§5) — a stopped VM still holds the slot,
   * and the lender's whole reason for a fixed term is to get the hardware back.
   */
  async function reclaimExpiredLoans(
    results: Awaited<ReturnType<typeof scanLoans>>,
    breachedBorrowers: ReadonlySet<string>
  ) {
    for (const { result, verdict } of reclaimPlan(results, breachedBorrowers)) {
      if (!verdict.reclaim) {
        // `not-expired` is the common no-op and stays silent. A breach is already warned about
        // above, once per borrower rather than once per VM.
        continue;
      }
      console.log(
        `[loan] ${result.vmName} on ${result.nodeName}: loan term ended — RECLAIMING. ` +
          `borrower=${verdict.borrowerSlug} expired=${verdict.expiresAt.toISOString()}`
      );
      try {
        const r = await deprovisionVm(result.vmName, result.nodeName, cfg);
        console.log(
          `[loan] ${result.vmName}: ${r.ok ? "reclaimed" : "FAILED"} — ` +
            `${(r.message ?? "").slice(0, 500)}`
        );
        // TODO(lamport §0.4 END step 2): sign a `LoanStatus: ended` and post it, so the hub can
        // repoint the borrower's rental home. No hub endpoint exists yet; until it does the
        // borrower's own agent finds out the same way the hub does — the VM reports `missing`.
      } catch (err) {
        // Idempotent by construction: the VM is still there, so the next cycle tries again.
        console.error(`[loan] ${result.vmName}: reclaim threw — ${(err as Error).message}`);
      }
    }
  }

  // Declare inventory first so the host/slot rows exist before listing + health.
  // These two are plain MT API calls — they cannot touch Proxmox, so awaiting them
  // can only stall on MT itself, and the rows must exist before anything references them.
  await reassertInventory();
  await reassertListing();

  // NOTHING below may gate the poll loop (#90). `refreshIsoOnce` alone can burn
  // TIMEOUT.refreshIso (20 min) PER declared host against a degraded Proxmox, and
  // health/courier reach a hypervisor and a remote console respectively. Awaiting
  // them meant a sick hypervisor stopped job claiming entirely while inventory and
  // listing had already stamped `agentLastSeenAt` — so the hub saw a healthy agent
  // that silently did no work, the worst possible failure shape.
  //
  // Trade-off, deliberate: a job claimed in the first seconds now runs before the
  // first ISO refresh has adopted a newer image, so it can still fail its own
  // staleness check. That is a single recoverable job failure with a named cause,
  // which beats a total claiming outage with none.
  runDetached("initial health report", reportHealthOnce);
  runDetached("initial courier run", courierOnce);
  runDetached("initial ISO refresh", () => refreshIsoOnce(cfg));
  const inventoryTimer = setInterval(reassertInventory, cfg.listingIntervalMs);
  const listingTimer = setInterval(reassertListing, cfg.listingIntervalMs);
  const healthTimer = setInterval(reportHealthOnce, cfg.healthIntervalMs);
  const courierTimer = setInterval(courierOnce, cfg.listingIntervalMs);
  const refreshIsoTimer = setInterval(() => refreshIsoOnce(cfg), cfg.refreshIsoIntervalMs);

  while (!stopping) {
    await pollOnce();
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
  clearInterval(inventoryTimer);
  clearInterval(listingTimer);
  clearInterval(healthTimer);
  clearInterval(courierTimer);
  clearInterval(refreshIsoTimer);
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
