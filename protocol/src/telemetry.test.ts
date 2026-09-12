/**
 * Phase 7 wire contract (protocol/TELEMETRY.md): `StatsSnapshot.nodes[]` and `EventReport`
 * are additive on SCHEMA_VERSION 2 — an old peer must keep parsing, a new peer must accept
 * an old payload, and the hub-facing shapes must reject what the hub would misread.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentEvent, EventReport, NodeSample, StatsSnapshot } from "./messages";
import { SCHEMA_VERSION } from "./common";

const base = {
  schemaVersion: SCHEMA_VERSION,
  providerSlug: "moltentech",
  collectedAt: "2026-09-12T20:00:00.000Z",
  tiers: [{ tier: "cumulus", nodeCount: 1 }],
};

test("SCHEMA_VERSION did not move for Phase 7", () => {
  assert.equal(SCHEMA_VERSION, 2);
});

test("StatsSnapshot without nodes[] still parses (pre-Phase-7 Coalition)", () => {
  const snap = StatsSnapshot.parse(base);
  assert.equal(snap.nodes, undefined);
});

test("StatsSnapshot carries raw per-node samples; unreachable node has only the two required fields", () => {
  const snap = StatsSnapshot.parse({
    ...base,
    nodes: [
      { vmName: "mt-186-c4", reachable: true, status: "CUMULUS", epsMultithread: 480.5, cores: 4, ddwrite: 310.2, benchmarkTime: 1757700000, ping: 12.5 },
      { vmName: "mt-186-n6", reachable: false },
    ],
  });
  assert.equal(snap.nodes?.length, 2);
  assert.equal(snap.nodes?.[1]?.epsMultithread, undefined);
});

test("NodeSample is raw: no derived epsPerCore/thresholdPass on the wire", () => {
  const s = NodeSample.parse({ vmName: "x", reachable: true, epsPerCore: 120, thresholdPass: true });
  assert.equal("epsPerCore" in s, false);
  assert.equal("thresholdPass" in s, false);
});

test("NodeSample rejects what the hub would misread", () => {
  assert.equal(NodeSample.safeParse({ vmName: "", reachable: true }).success, false);
  assert.equal(NodeSample.safeParse({ vmName: "x", reachable: "yes" }).success, false);
  assert.equal(NodeSample.safeParse({ vmName: "x", reachable: true, cores: 0 }).success, false);
  assert.equal(NodeSample.safeParse({ vmName: "x", reachable: true, benchmarkTime: 1.5 }).success, false);
});

test("EventReport: at least one event, at most 200, known kinds only", () => {
  const ev = { kind: "node_expired", vmName: "mt-186-c4", observedAt: "2026-09-12T20:01:00.000Z" };
  const report = { schemaVersion: SCHEMA_VERSION, providerSlug: "moltentech", reportedAt: "2026-09-12T20:01:05.000Z", events: [ev] };
  assert.equal(EventReport.safeParse(report).success, true);
  assert.equal(EventReport.safeParse({ ...report, events: [] }).success, false);
  assert.equal(EventReport.safeParse({ ...report, events: Array(201).fill(ev) }).success, false);
  assert.equal(AgentEvent.safeParse({ ...ev, kind: "node_started" }).success, false);
});

test("AgentEvent.detail is one line, capped at 200 chars", () => {
  const ev = { kind: "benchmark_failed", vmName: "x", observedAt: "2026-09-12T20:01:00.000Z" };
  assert.equal(AgentEvent.safeParse({ ...ev, detail: "ddwrite 50.69 MB/s under floor" }).success, true);
  assert.equal(AgentEvent.safeParse({ ...ev, detail: "line one\nline two" }).success, false);
  assert.equal(AgentEvent.safeParse({ ...ev, detail: "x".repeat(201) }).success, false);
});
