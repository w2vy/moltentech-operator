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

/**
 * Fetch the nodes MT wants measured (authoritative). Everything with a collateral txid,
 * INCLUDING `active` slots: an active node is the only one that can suffer a lapsed
 * registration, and MT's relist reaper needs it measured to notice. Filtering active out
 * here is what previously made a lapse invisible to the whole system.
 */
async function fetchWatchedNodes(cfg: CoalitionConfig, fetchImpl: typeof fetch): Promise<AgentNode[]> {
  const res = await fetchImpl(`${cfg.mtBaseUrl}/api/agent/nodes`, {
    headers: { Authorization: `Bearer ${cfg.agentKey}` },
  });
  if (!res.ok) throw new Error(`nodes list failed: ${res.status}`);
  const body = (await res.json()) as { nodes?: unknown[] };
  return (body.nodes ?? [])
    .map((n) => AgentNode.parse(n))
    .filter((n) => n.status && n.collateralTxid);
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

/**
 * Flux's default node port. A deterministic-list entry with a BARE address means this
 * port — measured on the live list: of 6071 nodes, 2306 were bare and exactly one carried
 * an explicit `:16127`. So bare and `:16127` are the same endpoint and must compare equal,
 * or every default-port node would read as a mismatch.
 */
const DEFAULT_FLUX_PORT = 16127;

/**
 * Normalize a deterministic-list `ip` to `host:port` for comparison.
 *
 * Returns null for anything unparseable, which the caller treats as "cannot prove this
 * entry is our endpoint" — fail-closed, consistent with the rest of this module.
 *
 * IPv6 is not special-cased: Flux's list is IPv4 in practice, and a bracketed IPv6
 * literal would fall out as unparseable rather than silently mis-comparing.
 */
export function normalizeListEndpoint(ip: unknown): string | null {
  if (typeof ip !== "string") return null;
  const trimmed = ip.trim();
  if (!trimmed || trimmed.includes("[")) return null;
  const parts = trimmed.split(":");
  if (parts.length === 1) return `${parts[0]}:${DEFAULT_FLUX_PORT}`;
  if (parts.length !== 2) return null;
  const [host, port] = parts;
  if (!host || !port || !/^\d+$/.test(port)) return null;
  return `${host}:${Number(port)}`;
}

/**
 * Is the node on the deterministic list yet (i.e. has it been Started) — AT THE ENDPOINT
 * we expect it to serve from?
 *
 * ⚠️ The endpoint half is load-bearing (#89). Matching on `txhash`+`outidx` alone answers
 * "is this COLLATERAL listed?", but the caller uses the answer as "is this NODE, at this
 * endpoint, listed?". Those diverge exactly during a move, which is when it matters:
 * observed twice on real hardware — once reporting `active` ~2 min early, and once
 * advertising a DESTROYED VM's endpoint for over 90 minutes while the replacement
 * bootstrapped. Collateral is stable across a move; the endpoint is the part that changes,
 * so the endpoint is what proves the new node is actually serving.
 *
 * Note a same-WAN-IP move shows up as a PORT change, not an address change — easy to
 * misread as "nothing happened".
 */
async function isOnDeterministicList(
  cfg: CoalitionConfig,
  txid: string,
  outputId: number,
  expectedEndpoint: string,
  fetchImpl: typeof fetch
): Promise<boolean | null> {
  let list: { txhash?: string; outidx?: unknown; ip?: unknown }[] | null;
  try {
    list = (await fluxApiGet(
      cfg,
      `/daemon/viewdeterministiczelnodelist?filter=${txid}`,
      fetchImpl
    )) as { txhash?: string; outidx?: unknown; ip?: unknown }[] | null;
  } catch (err) {
    // 🔑 UNREADABLE, not absent. This used to `return false`, collapsing "the Flux API is
    // down" into "this node is not registered". Harmless while the answer only ever
    // withheld a promotion; actively dangerous now that MT demotes off `false`, where it
    // would turn one bad API response into a fleet-wide demotion.
    console.error(`[collateral] deterministic-list check failed for ${txid}:`, (err as Error).message);
    return null;
  }
  for (const n of Array.isArray(list) ? list : []) {
    if (!n || n.txhash !== txid || String(n.outidx) !== String(outputId)) continue;
    const listed = normalizeListEndpoint(n.ip);
    if (listed === expectedEndpoint) return true;
    console.warn(
      `[collateral] ${txid}:${outputId} is listed at ${listed ?? String(n.ip)} but we expect ` +
        `${expectedEndpoint} — reporting UNKNOWN (a move in flight, not a lapsed registration)`
    );
    // Listed, but somewhere else. For a promotion that is "not yet serving here" — null
    // holds, exactly as false used to. For a lapse it is emphatically NOT evidence the
    // registration is gone: the collateral is right there on the list. Reporting false
    // would demote every node mid-move.
    return null;
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
 * One pass: fetch the nodes MT is watching, measure each (benchmark pass, collateral
 * confs, deterministic-list membership), report back to MT, and cache the snapshot for
 * the /console visibility section. Covers both directions of the lifecycle — maturing
 * nodes on their way to `active`, and active nodes that may have lapsed off the list.
 */
export async function checkCollateralOnce(cfg: CoalitionConfig, fetchImpl: typeof fetch = fetch): Promise<void> {
  const nodes = await fetchWatchedNodes(cfg, fetchImpl);
  const results = await Promise.all(
    nodes.map(async (node): Promise<LifecycleNodeStatus> => {
      const [benchmarkPassed, collateralConfs, onDeterministicList] = await Promise.all([
        fetchBenchmarkPassed(node, fetchImpl),
        getCollateralConfirmations(cfg, node.collateralTxid!, fetchImpl),
        // Same `host:apiPort` this module already polls for benchmarks — the endpoint MT
        // assigned the slot, so it is what the list entry must agree with.
        isOnDeterministicList(
          cfg,
          node.collateralTxid!,
          node.collateralVout ?? 0,
          `${node.host}:${node.apiPort}`,
          fetchImpl
        ),
      ]);
      return { vmName: node.vmName, benchmarkPassed, collateralConfs, onDeterministicList };
    })
  );
  latest = results;
  await postLifecycleReport(cfg, results, fetchImpl);
}
