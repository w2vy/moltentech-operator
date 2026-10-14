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

/**
 * What one pass remembers per node. `benchmarkStatus` is the raw benchmark word, NOT
 * `benchmarkPassed`: a pass → not-passed flip is also what a re-running benchmark
 * (`running`) or a timed-out read (null) looks like, and the first `benchmark_failed` ever
 * posted to prod (2026-09-12, mt-186-c4) was exactly that — a re-bench in progress, refuted
 * by the hub minutes later. Only the node's own verdict, `failed`, is an edge.
 */
export type LifecycleFacts = Pick<LifecycleNodeStatus, "onDeterministicList"> & { benchmarkStatus: string | null };

/** Compare two lifecycle passes keyed by vmName. Nodes absent from `prev` set a baseline only. */
export function diffLifecycle(
  prev: ReadonlyMap<string, LifecycleFacts>,
  cur: readonly (LifecycleNodeStatus & { benchmarkStatus: string | null })[],
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
    if (n.benchmarkStatus === "failed" && p.benchmarkStatus !== "failed") {
      out.push({ kind: "benchmark_failed", vmName: n.vmName, observedAt, detail: "benchmark reports failed" });
    }
  }
  return out;
}

/**
 * How many stats passes in a row (5 min apart) a node must miss before it is reported
 * unreachable. One miss is routine: a FluxOS release restarts every node's daemon in turn,
 * and on 2026-10-14 four nodes each missed exactly one pass — four "unreachable" events, all
 * back by the next pass, each one an alert. Three misses ≈ 10–15 min of silence.
 */
export const UNREACHABLE_AFTER_MISSES = 3;

/** What the reachability diff remembers per node between passes. */
export type ReachState = {
  /** What the hub was last told (or the baseline): true = up. */
  reportedUp: boolean;
  /** Passes in a row with no answer, while still reported up. */
  misses: number;
  /** When the current run of misses began — the event's `observedAt`. */
  firstMissAt: string | null;
};

/**
 * One stats pass of reachability → events + the state to carry to the next pass. A node seen
 * for the first time sets a baseline only. Down is reported on the UNREACHABLE_AFTER_MISSES-th
 * miss in a row, dated at the first; a node that answers again before that says nothing. Back
 * is reported on the first answer after a reported down.
 */
export function trackReachability(
  prev: ReadonlyMap<string, ReachState>,
  cur: readonly NodeSample[],
  observedAt: string,
  missesToReport: number = UNREACHABLE_AFTER_MISSES
): { events: AgentEvent[]; state: Map<string, ReachState> } {
  const events: AgentEvent[] = [];
  const state = new Map<string, ReachState>();
  for (const n of cur) {
    const p = prev.get(n.vmName);
    if (!p) {
      state.set(n.vmName, { reportedUp: n.reachable, misses: 0, firstMissAt: null });
      continue;
    }
    if (n.reachable) {
      if (!p.reportedUp) events.push({ kind: "node_recovered", vmName: n.vmName, observedAt, detail: "benchmark API answering again" });
      state.set(n.vmName, { reportedUp: true, misses: 0, firstMissAt: null });
      continue;
    }
    if (!p.reportedUp) {
      state.set(n.vmName, p);
      continue;
    }
    const misses = p.misses + 1;
    const firstMissAt = p.firstMissAt ?? observedAt;
    if (misses >= missesToReport) {
      events.push({
        kind: "node_unreachable",
        vmName: n.vmName,
        observedAt: firstMissAt,
        detail: `benchmark API stopped answering (${misses} checks in a row)`,
      });
      state.set(n.vmName, { reportedUp: false, misses: 0, firstMissAt: null });
    } else {
      state.set(n.vmName, { reportedUp: true, misses, firstMissAt });
    }
  }
  return { events, state };
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
