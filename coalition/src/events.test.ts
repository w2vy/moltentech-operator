/**
 * events.ts — the edge detector behind POST /api/agent/events (protocol/TELEMETRY.md D3),
 * and the raw sampler behind StatsSnapshot.nodes[] (D2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventReport, NodeSample, SCHEMA_VERSION } from "@moltentech/protocol";
import type { CoalitionConfig } from "./config";
import { diffLifecycle, diffReachability, postEvents } from "./events";
import { sampleFromBenchmarks } from "./stats";

const T = "2026-09-12T20:00:00.000Z";
const L = (vmName: string, onDeterministicList: boolean | null, benchmarkPassed = true) => ({
  vmName, benchmarkPassed, collateralConfs: 500, onDeterministicList,
});

test("first sight of a node is a baseline: no event", () => {
  assert.deepEqual(diffLifecycle(new Map(), [L("a", false)], T), []);
  assert.deepEqual(diffReachability(new Map(), [{ vmName: "a", reachable: false }], T), []);
});

test("det-list true → false is node_expired; false → true is node_recovered", () => {
  const prev = new Map([["a", { onDeterministicList: true, benchmarkPassed: true }], ["b", { onDeterministicList: false, benchmarkPassed: true }]]);
  const ev = diffLifecycle(prev, [L("a", false), L("b", true)], T);
  assert.deepEqual(ev.map((e) => [e.vmName, e.kind]), [["a", "node_expired"], ["b", "node_recovered"]]);
  assert.ok(ev.every((e) => e.observedAt === T));
});

test("null (unreadable) is not an edge in either direction", () => {
  const prev = new Map([["a", { onDeterministicList: true, benchmarkPassed: true }], ["b", { onDeterministicList: null, benchmarkPassed: true }]]);
  assert.deepEqual(diffLifecycle(prev, [L("a", null), L("b", false)], T), []);
});

test("a standing condition is reported once — the same state on the next pass is silent", () => {
  const prev = new Map([["a", { onDeterministicList: false, benchmarkPassed: false }]]);
  assert.deepEqual(diffLifecycle(prev, [L("a", false, false)], T), []);
});

test("benchmark true → false is benchmark_failed; false → true says nothing (the hub sees it in the report)", () => {
  const prev = new Map([["a", { onDeterministicList: true, benchmarkPassed: true }], ["b", { onDeterministicList: true, benchmarkPassed: false }]]);
  const ev = diffLifecycle(prev, [L("a", true, false), L("b", true, true)], T);
  assert.deepEqual(ev.map((e) => [e.vmName, e.kind]), [["a", "benchmark_failed"]]);
});

test("reachability edges", () => {
  const prev = new Map([["a", true], ["b", false], ["c", true]]);
  const ev = diffReachability(prev, [
    { vmName: "a", reachable: false }, { vmName: "b", reachable: true }, { vmName: "c", reachable: true },
  ], T);
  assert.deepEqual(ev.map((e) => [e.vmName, e.kind]), [["a", "node_unreachable"], ["b", "node_recovered"]]);
});

test("every emitted event validates against the wire schema", () => {
  const prev = new Map([["a", { onDeterministicList: true, benchmarkPassed: true }]]);
  const events = diffLifecycle(prev, [L("a", false, false)], T);
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
