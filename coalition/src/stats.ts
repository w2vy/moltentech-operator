import {
  SCHEMA_VERSION,
  AgentNode,
  type StatsSnapshot,
  type StatsTier,
  type TierKey,
} from "@moltentech/protocol";
import type { CoalitionConfig } from "./config";

// In-memory only — stats are regenerable, never persisted (the Coalition is stateless
// and runs on a Syncthing-replicated data partition where mutable files conflict).
let latest: StatsSnapshot | null = null;
export function getStatsSnapshot(): StatsSnapshot | null {
  return latest;
}

const NODE_TIMEOUT_MS = 10_000;

/** Fetch the provider's live node list from MT (authoritative). */
async function fetchNodes(cfg: CoalitionConfig, fetchImpl: typeof fetch): Promise<AgentNode[]> {
  const res = await fetchImpl(`${cfg.mtBaseUrl}/api/agent/nodes`, {
    headers: { Authorization: `Bearer ${cfg.agentKey}` },
  });
  if (!res.ok) throw new Error(`nodes list failed: ${res.status}`);
  const body = (await res.json()) as { nodes?: unknown[] };
  return (body.nodes ?? []).map((n) => AgentNode.parse(n));
}

type NodeSample = { reachable: boolean; epsPerCore?: number; ddwrite?: number };

/** Poll one node's Flux benchmark API from outside the operator LAN (hairpin-proof). */
async function pollNode(node: AgentNode, fetchImpl: typeof fetch): Promise<NodeSample> {
  const url = `http://${node.host}:${node.apiPort}/benchmark/getbenchmarks`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NODE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return { reachable: false };
    const json = (await res.json()) as { data?: Record<string, unknown> };
    const d = json.data ?? {};
    const cores = Number(d.cores) || null;
    const epsMt = Number(d.eps_multithread ?? d.eps) || null; // legacy: multithread/cores
    const ddwrite = Number(d.ddwrite) || null;
    return {
      reachable: true,
      epsPerCore: epsMt && cores ? epsMt / cores : undefined,
      ddwrite: ddwrite ?? undefined,
    };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Collect stats: pull the live node list from MT, poll each node's public Flux API
 * externally, and aggregate per tier into a StatsSnapshot (stored in memory, served
 * at /stats). On total failure the previous snapshot is retained (never blanked).
 *
 * v0.1 derives EPS/ddwrite/uptime from getbenchmarks (uptime = % reachable this
 * pass). pnrEligible/arcaneOs/responseTime are left null pending richer sources.
 */
export async function collectStats(cfg: CoalitionConfig, fetchImpl: typeof fetch = fetch): Promise<StatsSnapshot> {
  const nodes = await fetchNodes(cfg, fetchImpl);
  const samples = await Promise.all(nodes.map((n) => pollNode(n, fetchImpl).then((s) => ({ node: n, s }))));

  // Every offered tier gets a row (even with 0 nodes), so the card is stable.
  const offered = new Set<string>([...Object.keys(cfg.tierPrices), ...nodes.map((n) => n.tier)]);
  const tiers: StatsTier[] = [...offered].map((tier) => {
    const mine = samples.filter((x) => x.node.tier === tier);
    const reachable = mine.filter((x) => x.s.reachable);
    const eps = reachable.map((x) => x.s.epsPerCore).filter((v): v is number => v != null);
    const dd = reachable.map((x) => x.s.ddwrite).filter((v): v is number => v != null);
    return {
      tier: tier as TierKey,
      meanEpsPerCore: avg(eps),
      meanDdwrite: avg(dd),
      uptimePct: mine.length ? (reachable.length / mine.length) * 100 : null,
      nodeCount: mine.length,
      pnrEligiblePct: null,
      arcaneOsPct: null,
      responseTimeHours: null,
    };
  });

  latest = {
    schemaVersion: SCHEMA_VERSION,
    providerSlug: cfg.providerSlug,
    collectedAt: new Date().toISOString(),
    windowDays: cfg.statsWindowDays,
    tiers,
  };
  return latest;
}
