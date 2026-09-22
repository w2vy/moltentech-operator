/**
 * Lifecycle gates (hub `project_slot_lifecycle_syncing_state`, 2026-09-19): the Coalition
 * reads ONE public `/flux/info` per node and reports the raw words the hub turns into the
 * Installing / Benchmark / Started checklist. Pins:
 *  - a closed API port (installing / downloading) reports `apiReachable:false`, all null;
 *  - the `/flux/info` shape observed on prod nodes maps to the five new fields;
 *  - a FluxOS without the benchmark section falls back to `/benchmark/getbenchmarks`;
 *  - the report still satisfies the protocol schema, and an OLD hub (pre-gates schema)
 *    parses it — the fields are optional and the object is not strict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { z } from "zod";
import { LifecycleNodeStatus } from "@moltentech/protocol";
import { checkCollateralOnce } from "./collateral";
import type { CoalitionConfig } from "./config";

const SIGNING_KEY = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "der" })
  .subarray(-32)
  .toString("base64");
const TXID = "b".repeat(64);

const cfg = () =>
  ({
    port: 8088,
    providerSlug: "gates-test",
    mtBaseUrl: "https://mt.example",
    legacyBearersPresent: [],
    coalitionSigningKey: SIGNING_KEY,
    fluxApiUrl: "https://flux.example",
    fluxPayments: false,
  }) as unknown as CoalitionConfig;

/** The `/flux/info` shape read on mt-184-c4 (2026-09-19), trimmed to the fields we use. */
const fluxInfo = (bench: string, node: string, scan = 2_600_000, blocks = 2_960_000) => ({
  status: "success",
  data: {
    daemon: { info: { blocks, headers: blocks } },
    node: { status: { status: node, collateral: `COutPoint(${TXID}, 0)` } },
    benchmark: { bench: { status: bench, ipaddress: "1.2.3.4:16127" } },
    flux: { explorerScannedHeigth: { generalScannedHeight: scan }, connections: 12 },
  },
});

type Posted = Record<string, unknown>;

/** One pass with a stubbed network; returns the node entry the hub would receive. */
async function report(node: {
  /** null = the API port is closed: every node-API fetch throws. */
  info: unknown | null;
  benchmarks?: unknown;
}): Promise<Posted> {
  let posted: { nodes?: Posted[] } | undefined;
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/agent/nodes")) {
      return ok({
        nodes: [{ vmName: "vm-gates", tier: "cumulus", host: "1.2.3.4", apiPort: 16127, status: "benchmark", collateralTxid: TXID, collateralVout: 0 }],
      });
    }
    if (u.startsWith("http://1.2.3.4:16127/")) {
      if (u.endsWith("/flux/info")) {
        if (node.info === null) throw new Error("connect ECONNREFUSED");
        return ok(node.info);
      }
      if (u.endsWith("/benchmark/getbenchmarks")) {
        if (node.benchmarks === undefined) throw new Error("connect ECONNREFUSED");
        return ok(node.benchmarks);
      }
    }
    if (u.includes("/daemon/getrawtransaction")) return ok({ status: "success", data: { height: 100 } });
    if (u.includes("/daemon/getblockcount")) return ok({ status: "success", data: 1000 });
    if (u.includes("/daemon/viewdeterministiczelnodelist")) return ok({ status: "success", data: [] });
    if (u.endsWith("/api/agent/lifecycle")) {
      posted = JSON.parse(String(init?.body));
      return ok({});
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
  await checkCollateralOnce(cfg(), fetchImpl);
  assert.ok(posted?.nodes?.[0], "a lifecycle report should have been posted");
  return posted!.nodes![0];
}

test("a closed API port is the Installing gate: unreachable, every reading null", async () => {
  const n = await report({ info: null });
  assert.equal(n.apiReachable, false);
  assert.equal(n.benchmarkPassed, false);
  assert.equal(n.benchStatus, null);
  assert.equal(n.nodeStatus, null);
  assert.equal(n.scanHeight, null);
  assert.equal(n.chainHeight, null);
  // The collateral clock runs regardless of the node — it is read from the chain.
  assert.equal(n.collateralConfs, 901);
});

test("the API is up, bench mid-run, node not yet started (the shape right after the port opens)", async () => {
  const n = await report({ info: fluxInfo("running", "expired", 10, 2_960_000) });
  assert.equal(n.apiReachable, true);
  assert.equal(n.benchmarkPassed, false);
  assert.equal(n.benchStatus, "running");
  assert.equal(n.nodeStatus, "expired");
  assert.equal(n.scanHeight, 10);
  assert.equal(n.chainHeight, 2_960_000);
});

test("tier + CONFIRMED: benchmark passed, Started gate green", async () => {
  const n = await report({ info: fluxInfo("CUMULUS", "CONFIRMED") });
  assert.equal(n.benchmarkPassed, true);
  assert.equal(n.benchStatus, "CUMULUS");
  assert.equal(n.nodeStatus, "CONFIRMED");
});

test("`failed` is reachable + not passed, the raw word kept for the edge detector", async () => {
  const n = await report({ info: fluxInfo("failed", "STARTED") });
  assert.equal(n.apiReachable, true);
  assert.equal(n.benchmarkPassed, false);
  assert.equal(n.benchStatus, "failed");
  assert.equal(n.nodeStatus, "STARTED");
});

test("no benchmark section in /flux/info → falls back to getbenchmarks, keeps what info did say", async () => {
  const info = fluxInfo("x", "STARTED");
  delete (info.data as { benchmark?: unknown }).benchmark;
  const n = await report({ info, benchmarks: { status: "success", data: { status: "NIMBUS" } } });
  assert.equal(n.apiReachable, true);
  assert.equal(n.benchmarkPassed, true);
  assert.equal(n.benchStatus, "NIMBUS");
  assert.equal(n.nodeStatus, "STARTED");
  assert.equal(n.chainHeight, 2_960_000);
});

test("/flux/info missing entirely but getbenchmarks answering (older FluxOS) → reachable, bench only", async () => {
  const n = await report({ info: null, benchmarks: { status: "success", data: { benchmarking: "running" } } });
  assert.equal(n.apiReachable, true);
  assert.equal(n.benchStatus, "running");
  assert.equal(n.nodeStatus, null);
});

test("the report satisfies the protocol schema, and an OLD hub's schema still parses it", async () => {
  const n = await report({ info: fluxInfo("CUMULUS", "CONFIRMED") });
  assert.ok(LifecycleNodeStatus.safeParse(n).success);
  // The hub before this change: exactly the four original fields, not `.strict()`.
  const OldLifecycleNodeStatus = z.object({
    vmName: z.string().min(1),
    benchmarkPassed: z.boolean(),
    collateralConfs: z.number().int().nonnegative().nullable(),
    onDeterministicList: z.boolean().nullable(),
  });
  const old = OldLifecycleNodeStatus.safeParse(n);
  assert.ok(old.success);
  assert.deepEqual(Object.keys(old.data!).sort(), ["benchmarkPassed", "collateralConfs", "onDeterministicList", "vmName"]);
  // `benchmarkStatus` (Coalition-internal) never reaches the wire.
  assert.equal("benchmarkStatus" in n, false);
});
