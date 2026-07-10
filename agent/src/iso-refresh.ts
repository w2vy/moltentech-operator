import { reloadInventory, type AgentConfig } from "./config";
import { refreshIso, type IsoRefreshResult } from "./executor";

/**
 * Check the RunOnFlux release feed and stage a newer ArcaneOS/FluxLive ISO on every
 * declared inventory host, so third-party operators don't have to hand-refresh it
 * (the gap MT's own `check_arcaneos_iso.sh` cron covers for first-party only).
 *
 * Scoped to declared WS2 inventory (`cfg.inventory`/`AGENT_INVENTORY_PATH`) because
 * that's the only place the agent locally knows Proxmox node names — a slot's
 * `nodeName` otherwise only arrives reactively, inside a job, which is too late to
 * pre-empt that job's own ISO-staleness check. Operators who haven't declared
 * inventory keep today's behavior (static `ARCANE_ISO`, hard-fail on staleness).
 * `refreshIsoFn` defaults to the real `arcane-mage refresh-iso` wrapper and is
 * injectable so this is unit-testable like buildProvisionYaml, without needing to
 * mock the child_process/ESM layer underneath it. Lives in its own module (rather
 * than index.ts) so it can be imported by tests without triggering index.ts's
 * unconditional `main()` call.
 */
export async function refreshIsoOnce(
  cfg: AgentConfig,
  refreshIsoFn: typeof refreshIso = refreshIso
): Promise<void> {
  if (cfg.dryRun) return; // no local Proxmox to touch in dry-run
  const hosts = reloadInventory(cfg);
  if (hosts.length === 0) return; // no declared inventory = no known node to refresh

  let latestIso: string | undefined;
  for (const host of hosts) {
    const storageIso = host.storageIso ?? cfg.host.storageIso;
    try {
      const result: IsoRefreshResult = await refreshIsoFn(host.nodeName, storageIso, cfg.host.arcaneIso, cfg);
      if (!result.ok) {
        console.error(`[agent] ISO refresh failed on ${host.nodeName}: ${result.error}`);
        continue;
      }
      latestIso = result.iso;
      if (result.changed) {
        console.log(
          `[agent] staged new ArcaneOS ISO ${result.iso} on ${host.nodeName} ` +
            `(build ${result.build}, ${result.severity} severity)`
        );
      }
    } catch (err) {
      console.error(`[agent] ISO refresh error on ${host.nodeName}:`, (err as Error).message);
    }
  }

  // Same ISO for every host (single global release feed) — adopt it once so the
  // very next provision's buildProvisionYaml() picks it up, no restart needed.
  if (latestIso && latestIso !== cfg.host.arcaneIso) {
    console.log(`[agent] adopting ArcaneOS ISO ${cfg.host.arcaneIso} -> ${latestIso}`);
    cfg.host.arcaneIso = latestIso;
  }
}
