import {
  SCHEMA_VERSION,
  AgentNode,
  type LifecycleNodeStatus,
  type LifecycleReport,
} from "@moltentech/protocol";
import type { CoalitionConfig } from "./config";

/**
 * Collateral-confirmation guard, operator side. Flux rejects a fluxnode START
 * whose collateral UTXO has under ~100 confirmations and applies a DoS-score
 * cooldown. MT's first-party central provisioner already withholds the
 * customer's "go start your node" cue until benchmarks pass AND collateral
 * matures (`apps/provisioner/index.js` `checkBenchmarks()`), but that check
 * polls every node's public IP:apiPort centrally — exposed to hairpin-NAT
 * loopback failures and slated for removal along with first-party hosting.
 *
 * This module ports the same measurements to the operator's own Coalition,
 * which already polls nodes externally by design (see `stats.ts`, "hairpin-
 * proof"). Coalition only MEASURES — MT alone decides Slot transitions and
 * fires customer notifications, via POST /api/agent/lifecycle
 * (`apps/web/src/lib/collateral-guard.ts` on the MT side).
 */

const NODE_TIMEOUT_MS = 10_000;
const FLUX_TIMEOUT_MS = 10_000;
const PASSED_TIERS = new Set(["CUMULUS", "NIMBUS", "STRATUS"]);

// In-memory only — regenerable, never persisted (Coalition is stateless; see
// the same rationale in stats.ts). Powers the /console maturing-nodes section.
let latest: LifecycleNodeStatus[] = [];
export function getCollateralSnapshot(): LifecycleNodeStatus[] {
  return latest;
}

/** Fetch the provider's non-active (still-maturing) nodes from MT (authoritative). */
async function fetchPendingNodes(cfg: CoalitionConfig, fetchImpl: typeof fetch): Promise<AgentNode[]> {
  const res = await fetchImpl(`${cfg.mtBaseUrl}/api/agent/nodes`, {
    headers: { Authorization: `Bearer ${cfg.agentKey}` },
  });
  if (!res.ok) throw new Error(`nodes list failed: ${res.status}`);
  const body = (await res.json()) as { nodes?: unknown[] };
  return (body.nodes ?? [])
    .map((n) => AgentNode.parse(n))
    .filter((n) => n.status && n.status !== "active" && n.collateralTxid);
}

/** Poll one node's Flux benchmark API from outside the operator LAN (hairpin-proof). */
async function fetchBenchmarkPassed(node: AgentNode, fetchImpl: typeof fetch): Promise<boolean> {
  const url = `http://${node.host}:${node.apiPort}/benchmark/getbenchmarks`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NODE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return false;
    const json = (await res.json()) as { data?: { benchmarking?: string; status?: string } };
    const benchStatus = json.data?.benchmarking ?? json.data?.status;
    return !!benchStatus && PASSED_TIERS.has(benchStatus);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal read-only Flux public-API GET. Unwraps the {status,data} envelope. */
async function fluxApiGet(cfg: CoalitionConfig, apiPath: string, fetchImpl: typeof fetch): Promise<unknown> {
  const url = `${cfg.fluxApiUrl}${apiPath}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FLUX_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { status?: string; data?: unknown };
    if (json && json.status === "error") {
      throw new Error((json.data as { message?: string } | undefined)?.message ?? "Flux API error");
    }
    return json && typeof json === "object" && "data" in json ? json.data : json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Confirmations on a node's collateral funding tx. Returns null if unreadable,
 * so the caller fails closed (MT holds the cue) rather than risk a premature
 * Start. NOTE: api.runonflux.io caches the per-tx `.confirmations` field —
 * observed frozen at a stale value while the chain advanced past it — so confs
 * are derived from the live tip (`getblockcount - tx.height + 1`) instead of
 * trusting that field. Ported verbatim from
 * apps/provisioner/index.js `getCollateralConfirmations()`.
 */
async function getCollateralConfirmations(
  cfg: CoalitionConfig,
  txid: string,
  fetchImpl: typeof fetch
): Promise<number | null> {
  try {
    const tx = (await fluxApiGet(cfg, `/daemon/getrawtransaction/${txid}/1`, fetchImpl)) as
      | { height?: number; confirmations?: number }
      | null;
    if (!tx) return null;
    if (typeof tx.height !== "number" || tx.height <= 0) {
      return typeof tx.confirmations === "number" ? tx.confirmations : 0;
    }
    const blockcount = (await fluxApiGet(cfg, `/daemon/getblockcount`, fetchImpl)) as number;
    if (typeof blockcount !== "number" || blockcount < tx.height) return null;
    return blockcount - tx.height + 1;
  } catch (err) {
    console.error(`[collateral] confirmation check failed for ${txid}:`, (err as Error).message);
    return null;
  }
}

/** Is the node on the deterministic list yet (i.e. has it been Started)? */
async function isOnDeterministicList(
  cfg: CoalitionConfig,
  txid: string,
  outputId: number,
  fetchImpl: typeof fetch
): Promise<boolean> {
  try {
    const list = (await fluxApiGet(
      cfg,
      `/daemon/viewdeterministiczelnodelist?filter=${txid}`,
      fetchImpl
    )) as { txhash?: string; outidx?: unknown }[] | null;
    for (const n of Array.isArray(list) ? list : []) {
      if (n && n.txhash === txid && String(n.outidx) === String(outputId)) return true;
    }
  } catch (err) {
    console.error(`[collateral] deterministic-list check failed for ${txid}:`, (err as Error).message);
  }
  return false;
}

/** Report measurements back to MT; MT decides Slot transitions + notifications. */
async function postLifecycleReport(
  cfg: CoalitionConfig,
  nodes: LifecycleNodeStatus[],
  fetchImpl: typeof fetch
): Promise<void> {
  if (nodes.length === 0) return;
  const payload: LifecycleReport = {
    schemaVersion: SCHEMA_VERSION,
    providerSlug: cfg.providerSlug,
    reportedAt: new Date().toISOString(),
    nodes,
  };
  const res = await fetchImpl(`${cfg.mtBaseUrl}/api/agent/lifecycle`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.agentKey}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`lifecycle report failed: ${res.status}`);
}

/**
 * One pass: fetch the provider's still-maturing nodes from MT, measure each
 * (benchmark pass, collateral confs, deterministic-list membership), report
 * back to MT, and cache the snapshot for the /console visibility section.
 */
export async function checkCollateralOnce(cfg: CoalitionConfig, fetchImpl: typeof fetch = fetch): Promise<void> {
  const nodes = await fetchPendingNodes(cfg, fetchImpl);
  const results = await Promise.all(
    nodes.map(async (node): Promise<LifecycleNodeStatus> => {
      const [benchmarkPassed, collateralConfs, onDeterministicList] = await Promise.all([
        fetchBenchmarkPassed(node, fetchImpl),
        getCollateralConfirmations(cfg, node.collateralTxid!, fetchImpl),
        isOnDeterministicList(cfg, node.collateralTxid!, node.collateralVout ?? 0, fetchImpl),
      ]);
      return { vmName: node.vmName, benchmarkPassed, collateralConfs, onDeterministicList };
    })
  );
  latest = results;
  await postLifecycleReport(cfg, results, fetchImpl);
}
