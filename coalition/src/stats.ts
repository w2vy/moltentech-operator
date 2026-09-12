import {
  SCHEMA_VERSION,
  AgentNode,
  type NodeSample,
  type StatsSnapshot,
  type StatsTier,
  type TierKey,
  hubError,
} from "@moltentech/protocol";
import type { CoalitionConfig } from "./config";
import { mtAuthHeaders } from "./coalition-signing";
import { diffReachability, postEvents } from "./events";

// In-memory only — stats are regenerable, never persisted (the Coalition is stateless
// and runs on a Syncthing-replicated data partition where mutable files conflict).
let latest: StatsSnapshot | null = null;
export function getStatsSnapshot(): StatsSnapshot | null {
  return latest;
}

const NODE_TIMEOUT_MS = 10_000;

// Last pass's `reachable` per vmName for the edge detector; empty after a restart on purpose.
let prevReachable: ReadonlyMap<string, boolean> = new Map();

/** Fetch the provider's live node list from MT (authoritative). */
async function fetchNodes(cfg: CoalitionConfig, fetchImpl: typeof fetch): Promise<AgentNode[]> {
  const res = await fetchImpl(`${cfg.mtBaseUrl}/api/agent/nodes`, {
    headers: mtAuthHeaders(cfg, "GET", "/api/agent/nodes", ""),
  });
  if (!res.ok) throw await hubError("nodes list", res);
  const body = (await res.json()) as { nodes?: unknown[] };
  return (body.nodes ?? []).map((n) => AgentNode.parse(n));
}

/**
 * Poll one node's Flux benchmark API from outside the operator LAN (hairpin-proof) and keep
 * the RAW reading (protocol/TELEMETRY.md, Decision 2): the hub derives epsPerCore and the
 * tier pass itself, so nothing is computed here beyond `epsMultithread ?? eps`.
 */
async function pollNode(node: AgentNode, fetchImpl: typeof fetch): Promise<NodeSample> {
  const url = `http://${node.host}:${node.apiPort}/benchmark/getbenchmarks`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NODE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return { vmName: node.vmName, reachable: false };
    const json = (await res.json()) as { data?: Record<string, unknown> };
    return sampleFromBenchmarks(node.vmName, json.data ?? {});
  } catch {
    return { vmName: node.vmName, reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

/** `getbenchmarks` `data` → NodeSample. Exported for tests; numeric garbage becomes "absent". */
export function sampleFromBenchmarks(vmName: string, d: Record<string, unknown>): NodeSample {
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n !== 0 ? n : undefined;
  };
  const int = (v: unknown): number | undefined => {
    const n = num(v);
    return n !== undefined && Number.isInteger(n) ? n : undefined;
  };
  const cores = int(d.cores);
  const s: NodeSample = {
    vmName,
    reachable: true,
    status: typeof d.status === "string" && d.status ? d.status : undefined,
    epsMultithread: num(d.eps_multithread ?? d.eps),
    cores: cores !== undefined && cores > 0 ? cores : undefined,
    ddwrite: num(d.ddwrite),
    benchmarkTime: int(d.time),
    downloadSpeed: num(d.download_speed),
    uploadSpeed: num(d.upload_speed),
    ping: num(d.ping),
  };
  // Optional fields are OMITTED, not `undefined`, so JSON.stringify and the Zod schema agree.
  for (const k of Object.keys(s) as (keyof NodeSample)[]) if (s[k] === undefined) delete s[k];
  return s;
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
    // Same legacy convention as before this kept raw samples: multithread / cores.
    const eps = reachable
      .map((x) => (x.s.epsMultithread && x.s.cores ? x.s.epsMultithread / x.s.cores : undefined))
      .filter((v): v is number => v != null);
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

  const nodeSamples = samples.map((x) => x.s);
  const collectedAt = new Date().toISOString();
  latest = {
    schemaVersion: SCHEMA_VERSION,
    providerSlug: cfg.providerSlug,
    collectedAt,
    windowDays: cfg.statsWindowDays,
    tiers,
    nodes: nodeSamples,
  };

  // Edge-triggered reachability hints (events.ts). Baseline on the first pass.
  const events = diffReachability(prevReachable, nodeSamples, collectedAt);
  prevReachable = new Map(nodeSamples.map((s) => [s.vmName, s.reachable]));
  await postEvents(cfg, events, fetchImpl);

  return latest;
}
