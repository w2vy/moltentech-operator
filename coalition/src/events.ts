import {
  SCHEMA_VERSION,
  type AgentEvent,
  type EventReport,
  type LifecycleNodeStatus,
  type NodeSample,
  hubError,
} from "@moltentech/protocol";
import type { CoalitionConfig } from "./config";
import { mtAuthHeaders } from "./coalition-signing";

/**
 * Edge-triggered hints to the hub (protocol/TELEMETRY.md, Decision 3).
 *
 * The two collectors (`collateral.ts`, `stats.ts`) already measure every node every few
 * minutes; this module turns a CHANGE between two of their passes into an `AgentEvent` and
 * posts it. Rules that shape it:
 *
 * - Hints, never facts. The hub verifies before it acts; nothing here decides anything.
 * - Edge-triggered. A standing condition is reported once, at the transition. `null`
 *   (unreadable) is not an edge in either direction — one sour Flux API read must not
 *   emit "expired" for a whole fleet.
 * - Baseline first. A node seen for the first time (including the first pass after a
 *   restart — the Coalition is stateless) emits nothing.
 * - Best-effort delivery. A failed POST is one log line and the events are dropped; the
 *   hub's own sweep is the safety net. No queue, no retry.
 */

export type LifecycleFacts = Pick<LifecycleNodeStatus, "benchmarkPassed" | "onDeterministicList">;

/** Compare two lifecycle passes keyed by vmName. Nodes absent from `prev` set a baseline only. */
export function diffLifecycle(
  prev: ReadonlyMap<string, LifecycleFacts>,
  cur: readonly LifecycleNodeStatus[],
  observedAt: string
): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const n of cur) {
    const p = prev.get(n.vmName);
    if (!p) continue;
    if (p.onDeterministicList === true && n.onDeterministicList === false) {
      out.push({ kind: "node_expired", vmName: n.vmName, observedAt, detail: "left the deterministic list" });
    } else if (p.onDeterministicList === false && n.onDeterministicList === true) {
      out.push({ kind: "node_recovered", vmName: n.vmName, observedAt, detail: "back on the deterministic list" });
    }
    if (p.benchmarkPassed && !n.benchmarkPassed) {
      out.push({ kind: "benchmark_failed", vmName: n.vmName, observedAt, detail: "benchmark no longer reports a supported tier" });
    }
  }
  return out;
}

/** Compare two stats passes on `reachable` alone. */
export function diffReachability(
  prev: ReadonlyMap<string, boolean>,
  cur: readonly NodeSample[],
  observedAt: string
): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const n of cur) {
    const p = prev.get(n.vmName);
    if (p === undefined) continue;
    if (p && !n.reachable) out.push({ kind: "node_unreachable", vmName: n.vmName, observedAt, detail: "benchmark API stopped answering" });
    else if (!p && n.reachable) out.push({ kind: "node_recovered", vmName: n.vmName, observedAt, detail: "benchmark API answering again" });
  }
  return out;
}

/** Cap from the wire schema (`EventReport.events.max`). */
const MAX_EVENTS_PER_REPORT = 200;

/**
 * POST the events, best-effort. Returns true if the hub accepted them. A 404 is the
 * expected answer from a hub that predates Phase 7 and is logged at the same level as any
 * other failure — one line, no retry.
 */
export async function postEvents(
  cfg: CoalitionConfig,
  events: readonly AgentEvent[],
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (events.length === 0) return true;
  const payload: EventReport = {
    schemaVersion: SCHEMA_VERSION,
    providerSlug: cfg.providerSlug,
    reportedAt: new Date().toISOString(),
    events: events.slice(0, MAX_EVENTS_PER_REPORT),
  };
  const rawBody = JSON.stringify(payload);
  try {
    const res = await fetchImpl(`${cfg.mtBaseUrl}/api/agent/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...mtAuthHeaders(cfg, "POST", "/api/agent/events", rawBody),
      },
      body: rawBody,
    });
    if (!res.ok) throw await hubError("event report", res);
    console.log(`[events] reported ${payload.events.length}: ${payload.events.map((e) => `${e.vmName}=${e.kind}`).join(" ")}`);
    return true;
  } catch (err) {
    console.error(`[events] dropped ${payload.events.length} event(s):`, (err as Error).message);
    return false;
  }
}
