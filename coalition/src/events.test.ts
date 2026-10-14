/**
 * events.ts — the edge detector behind POST /api/agent/events (protocol/TELEMETRY.md D3),
 * and the raw sampler behind StatsSnapshot.nodes[] (D2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventReport, NodeSample, SCHEMA_VERSION } from "@moltentech/protocol";
import type { CoalitionConfig } from "./config";
import { diffLifecycle, trackReachability, postEvents, UNREACHABLE_AFTER_MISSES, type ReachState } from "./events";
import { sampleFromBenchmarks } from "./stats";

const T = "2026-09-12T20:00:00.000Z";
const L = (vmName: string, onDeterministicList: boolean | null, benchmarkStatus: string | null = "CUMULUS") => ({
  vmName, benchmarkPassed: benchmarkStatus === "CUMULUS", collateralConfs: 500, onDeterministicList, benchmarkStatus,
});
const F = (onDeterministicList: boolean | null, benchmarkStatus: string | null = "CUMULUS") => ({ onDeterministicList, benchmarkStatus });

test("first sight of a node is a baseline: no event", () => {
  assert.deepEqual(diffLifecycle(new Map(), [L("a", false)], T), []);
  assert.deepEqual(trackReachability(new Map(), [{ vmName: "a", reachable: false }], T).events, []);
});

test("det-list true → false is node_expired; false → true is node_recovered", () => {
  const prev = new Map([["a", F(true)], ["b", F(false)]]);
  const ev = diffLifecycle(prev, [L("a", false), L("b", true)], T);
  assert.deepEqual(ev.map((e) => [e.vmName, e.kind]), [["a", "node_expired"], ["b", "node_recovered"]]);
  assert.ok(ev.every((e) => e.observedAt === T));
});

test("null (unreadable) is not an edge in either direction", () => {
  const prev = new Map([["a", F(true)], ["b", F(null)]]);
  assert.deepEqual(diffLifecycle(prev, [L("a", null), L("b", false)], T), []);
});

test("a standing condition is reported once — the same state on the next pass is silent", () => {
  const prev = new Map([["a", F(false, "failed")]]);
  assert.deepEqual(diffLifecycle(prev, [L("a", false, "failed")], T), []);
});

test("benchmark entering `failed` is benchmark_failed; leaving it says nothing (the hub sees it in the report)", () => {
  const prev = new Map([["a", F(true)], ["b", F(true, "failed")]]);
  const ev = diffLifecycle(prev, [L("a", true, "failed"), L("b", true, "CUMULUS")], T);
  assert.deepEqual(ev.map((e) => [e.vmName, e.kind]), [["a", "benchmark_failed"]]);
});

test("🔴 a re-running benchmark, or a node that did not answer, is NOT benchmark_failed (prod 2026-09-12)", () => {
  const prev = new Map([["a", F(true)], ["b", F(true)], ["c", F(true, "running")]]);
  const ev = diffLifecycle(prev, [L("a", true, "running"), L("b", true, null), L("c", true, "failed")], T);
  assert.deepEqual(ev.map((e) => [e.vmName, e.kind]), [["c", "benchmark_failed"]]);
});

const at = (min: number) => new Date(Date.parse(T) + min * 60_000).toISOString();
/** Run passes in order; each pass is the `reachable` of node "a". Returns every event emitted. */
function runPasses(passes: boolean[]) {
  let state: ReadonlyMap<string, ReachState> = new Map();
  const all = [];
  for (const [i, reachable] of passes.entries()) {
    const r = trackReachability(state, [{ vmName: "a", reachable }], at(i * 5));
    state = r.state;
    all.push(...r.events);
  }
  return all;
}

test("🔴 one missed check (a FluxOS update restart) says nothing (prod 2026-10-14)", () => {
  assert.deepEqual(runPasses([true, false, true, true]), []);
});

test("two misses in a row still say nothing", () => {
  assert.equal(UNREACHABLE_AFTER_MISSES, 3);
  assert.deepEqual(runPasses([true, false, false, true]), []);
});

test("three misses in a row: node_unreachable dated at the FIRST miss, once; back is node_recovered", () => {
  const ev = runPasses([true, false, false, false, false, true]);
  assert.deepEqual(ev.map((e) => [e.kind, e.observedAt]), [["node_unreachable", at(5)], ["node_recovered", at(25)]]);
});

test("a miss run broken by an answer starts counting again", () => {
  assert.deepEqual(runPasses([true, false, false, true, false, false, true]), []);
});

test("a node first seen unreachable is a baseline; its first answer is node_recovered", () => {
  assert.deepEqual(runPasses([false, false, true]).map((e) => e.kind), ["node_recovered"]);
});

test("every emitted event validates against the wire schema", () => {
  const prev = new Map([["a", F(true)]]);
  const events = diffLifecycle(prev, [L("a", false, "failed")], T);
  assert.equal(events.length, 2);
  const r = EventReport.safeParse({ schemaVersion: SCHEMA_VERSION, providerSlug: "moltentech", reportedAt: T, events });
  assert.equal(r.success, true, JSON.stringify(r));
});

test("sampleFromBenchmarks keeps raw fields, omits garbage, never derives", () => {
  const s = sampleFromBenchmarks("mt-1", {
    status: "CUMULUS", eps_multithread: "480.5", cores: 4, ddwrite: 310.2, time: 1757700000,
    download_speed: "n/a", upload_speed: 0, ping: 12.5,
  });
  assert.deepEqual(s, { vmName: "mt-1", reachable: true, status: "CUMULUS", epsMultithread: 480.5, cores: 4, ddwrite: 310.2, benchmarkTime: 1757700000, ping: 12.5 });
  assert.equal(NodeSample.safeParse(s).success, true);
  assert.equal(NodeSample.safeParse(JSON.parse(JSON.stringify(s))).success, true);
  // legacy `eps` fallback, fractional cores rejected
  const t = sampleFromBenchmarks("mt-2", { eps: 100, cores: 2.5, time: 1.5 });
  assert.deepEqual(t, { vmName: "mt-2", reachable: true, epsMultithread: 100 });
});

test("postEvents is best-effort: a 404 from an old hub is one log line and false, never a throw", async () => {
  const cfg = { providerSlug: "moltentech", mtBaseUrl: "http://hub", coalitionSigningKey: undefined } as unknown as CoalitionConfig;
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => { calls.push(url); return new Response("nope", { status: 404 }); }) as unknown as typeof fetch;
  // No signing key configured → mtAuthHeaders throws → caught → false, and nothing was sent.
  const ok = await postEvents(cfg, [{ kind: "node_expired", vmName: "a", observedAt: T }], fetchImpl);
  assert.equal(ok, false);
  assert.deepEqual(calls, []);
  // Nothing to send is a no-op success.
  assert.equal(await postEvents(cfg, [], fetchImpl), true);
});
