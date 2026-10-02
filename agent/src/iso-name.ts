import type { AgentConfig } from "./config";
import { getStorageIsoNames } from "./health";

/**
 * The FluxLive ISO NAME the agent hands arcane-mage — and how it heals when it is wrong.
 *
 * arcane-mage only accepts a dated name (`iso_name` must match `^FluxLive-\d{10}\.iso$`). The
 * agent learns the dated name from an ISO refresh and keeps it in memory, so a restart puts it
 * back to `ARCANE_ISO` from the env. If that is a bare `FluxLive.iso` and the refresh then fails
 * (2026-10-01: the host was powered off), every provision fails config validation — MT-0091's
 * loan return, 2026-10-02 08:41 ET.
 *
 * The ISO itself is fine all along: it sits on the ISO storage. So when the configured name is
 * not a dated one, take the newest dated FluxLive ISO that storage actually holds.
 */

export const DATED_FLUXLIVE_RE = /^FluxLive-(\d{10})\.iso$/;

export function isDatedFluxLiveIso(name: string | undefined | null): boolean {
  return !!name && DATED_FLUXLIVE_RE.test(name);
}

/** The newest dated FluxLive ISO among `names` (by its build stamp), or null. */
export function newestFluxLiveIso(names: string[]): string | null {
  let best: { name: string; stamp: number } | null = null;
  for (const name of names) {
    const m = DATED_FLUXLIVE_RE.exec(name);
    if (!m) continue;
    const stamp = Number(m[1]);
    if (!best || stamp > best.stamp) best = { name, stamp };
  }
  return best?.name ?? null;
}

export type ListIsosFn = (cfg: AgentConfig, node: string, storage: string) => Promise<string[]>;

/**
 * Make sure `cfg.host.arcaneIso` is a dated name, reading the ISO storage through `node` when it
 * is not. Adopts in place (same as the refresh does) and returns the name in force afterwards.
 * Best-effort: no creds, an unreadable storage or no dated ISO there leaves the name as it was,
 * and the provision fails the way it always did — never worse.
 */
export async function ensureDatedIso(
  cfg: AgentConfig,
  node: string,
  storage: string,
  listIsos: ListIsosFn = getStorageIsoNames
): Promise<string> {
  const current = cfg.host.arcaneIso;
  if (isDatedFluxLiveIso(current)) return current;
  if (!cfg.proxmox?.url || !cfg.proxmox.tokenId || !cfg.proxmox.tokenSecret) return current;
  try {
    const newest = newestFluxLiveIso(await listIsos(cfg, node, storage));
    if (!newest) {
      console.error(`[agent] ARCANE_ISO=${current || "(unset)"} is not a dated FluxLive ISO, and ${storage} on ${node} holds none`);
      return current;
    }
    console.log(`[agent] ARCANE_ISO=${current || "(unset)"} is not a dated FluxLive ISO — using ${newest} from ${storage} on ${node}`);
    cfg.host.arcaneIso = newest;
    return newest;
  } catch (err) {
    console.error(`[agent] could not read ISOs on ${storage} via ${node}: ${(err as Error).message}`);
    return current;
  }
}
