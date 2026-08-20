/**
 * #89 — `isOnDeterministicList` must agree on the ENDPOINT, not just the collateral.
 *
 * Matching on `txhash`+`outidx` alone answers "is this collateral listed?" while the
 * caller uses the answer as "is this node, at this endpoint, listed?". Collateral is
 * stable across a move; the endpoint is precisely what changes. Observed twice on real
 * hardware (2026-08-08, moving rental MT-0007): once `active` was reported ~2 minutes
 * early, and once the list advertised a DESTROYED VM's endpoint for over 90 minutes
 * while the replacement bootstrapped — a node that never came up would have read
 * `active` forever.
 *
 * These tests pin both halves: the bare-address normalization (a default-port node must
 * NOT read as a mismatch) and the end-to-end report that MT actually consumes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeListEndpoint, checkCollateralOnce } from "./collateral";
import type { CoalitionConfig } from "./config";

const TXID = "a".repeat(64);

// ───────────────────────────────────────────────────────────────────────────
// normalization
// ───────────────────────────────────────────────────────────────────────────

test("a bare address means the default Flux port", () => {
  assert.equal(normalizeListEndpoint("1.2.3.4"), "1.2.3.4:16127");
});

test("bare and explicit :16127 are the SAME endpoint", () => {
  // The whole fleet's default-port nodes ride on this: 2306 of 6071 listed nodes are
  // bare. If these compared unequal, every one of them would read as a mismatch.
  assert.equal(normalizeListEndpoint("1.2.3.4"), normalizeListEndpoint("1.2.3.4:16127"));
});

test("an explicit non-default port is preserved", () => {
  assert.equal(normalizeListEndpoint("1.2.3.4:16137"), "1.2.3.4:16137");
});

test("a port is compared numerically, not textually", () => {
  assert.equal(normalizeListEndpoint("1.2.3.4:016127"), "1.2.3.4:16127");
});

test("unparseable entries return null rather than a bogus endpoint", () => {
  for (const bad of [undefined, null, 42, "", "   ", "1.2.3.4:", "1.2.3.4:abc", "[::1]:16127", "a:b:c"]) {
    assert.equal(normalizeListEndpoint(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// end-to-end: what MT actually receives
// ───────────────────────────────────────────────────────────────────────────

function cfg(): CoalitionConfig {
  return {
    port: 8088,
    providerSlug: "endpoint-test",
    mtBaseUrl: "https://mt.example",
    agentKey: "agent-key",
    fluxApiUrl: "https://flux.example",
  } as unknown as CoalitionConfig;
}

/**
 * Drives one `checkCollateralOnce` pass with a stubbed network and returns the
 * `onDeterministicList` value that would reach MT.
 *
 * `listedIp` is what the deterministic list advertises; the node itself is always at
 * `host`/`apiPort`, so the two disagree exactly when a move is mid-flight.
 */
async function reportedOnList(opts: {
  host: string;
  apiPort: number;
  listedIp?: unknown;
  /** Omit the node from the list entirely — a genuinely absent registration. */
  absent?: boolean;
  /** Make the deterministic-list call fail — unreadable, which is NOT absent. */
  listUnreadable?: boolean;
  /** The slot status MT hands out; `active` is what the relist reaper watches. */
  status?: string;
}): Promise<boolean | null> {
  let posted: { nodes?: { onDeterministicList?: boolean | null }[] } | undefined;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const ok = (body: unknown) =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

    if (u.endsWith("/api/agent/nodes")) {
      return ok({
        nodes: [
          {
            vmName: "vm-under-test",
            // Slot tiers are lowercase; the uppercase `CUMULUS` below is the Flux
            // benchmark API's own vocabulary, not this one.
            tier: "cumulus",
            host: opts.host,
            apiPort: opts.apiPort,
            status: opts.status ?? "awaiting_start",
            collateralTxid: TXID,
            collateralVout: 0,
          },
        ],
      });
    }
    // Benchmark poll — passing, so it cannot be the reason a slot is held back.
    if (u.includes("/benchmark/getbenchmarks")) return ok({ data: { status: "CUMULUS" } });
    // Collateral matured, likewise.
    if (u.includes("/daemon/getrawtransaction")) return ok({ status: "success", data: { height: 100 } });
    if (u.includes("/daemon/getblockcount")) return ok({ status: "success", data: 1000 });
    if (u.includes("/daemon/viewdeterministiczelnodelist")) {
      if (opts.listUnreadable) return { ok: false, status: 502 } as unknown as Response;
      if (opts.absent) return ok({ status: "success", data: [] });
      return ok({ status: "success", data: [{ txhash: TXID, outidx: 0, ip: opts.listedIp }] });
    }
    if (u.endsWith("/api/agent/lifecycle")) {
      posted = JSON.parse(String(init?.body));
      return ok({});
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;

  await checkCollateralOnce(cfg(), fetchImpl);
  assert.ok(posted?.nodes?.[0], "a lifecycle report should have been posted");
  return posted!.nodes![0].onDeterministicList ?? null;
}

test("listed AT the expected endpoint → on-list", async () => {
  assert.equal(await reportedOnList({ host: "1.2.3.4", apiPort: 16127, listedIp: "1.2.3.4:16127" }), true);
});

test("listed BARE while we expect the default port → still on-list", async () => {
  assert.equal(await reportedOnList({ host: "1.2.3.4", apiPort: 16127, listedIp: "1.2.3.4" }), true);
});

test("listed at a DESTROYED VM's address → UNKNOWN, not off-list", async () => {
  // The 90-minute stall: collateral matches, the endpoint is the old VM's. It still
  // holds the promotion (null is falsy to the forward guard) but must never read as a
  // lapsed registration — the collateral is right there on the list.
  assert.equal(await reportedOnList({ host: "1.2.3.4", apiPort: 16127, listedIp: "9.9.9.9:16127" }), null);
});

test("same WAN IP, different PORT → UNKNOWN, not off-list", async () => {
  // A move between two slots behind one WAN IP shows up as a port appearing, not an
  // address changing — the case most easily misread as "nothing happened".
  assert.equal(await reportedOnList({ host: "1.2.3.4", apiPort: 16137, listedIp: "1.2.3.4" }), null);
});

test("a missing or unreadable ip field → UNKNOWN (fail closed both ways)", async () => {
  assert.equal(await reportedOnList({ host: "1.2.3.4", apiPort: 16127, listedIp: undefined }), null);
  assert.equal(await reportedOnList({ host: "1.2.3.4", apiPort: 16127, listedIp: "garbage" }), null);
});

// ───────────────────────────────────────────────────────────────────────────
// tri-state: the distinction MT's relist reaper demotes on
// ───────────────────────────────────────────────────────────────────────────

test("🔑 absent from the list is FALSE — the one input that may demote", async () => {
  assert.equal(await reportedOnList({ host: "1.2.3.4", apiPort: 16127, absent: true }), false);
});

test("🔑 an unreadable Flux API is NULL, never false", async () => {
  // Collapsed into `false` this is a fleet-wide demotion on one bad API response —
  // which is exactly what the old `catch { return false }` would have produced.
  assert.equal(await reportedOnList({ host: "1.2.3.4", apiPort: 16127, listUnreadable: true }), null);
});

test("🔑 ACTIVE slots are measured too, or a lapse is invisible", async () => {
  // The collector used to filter `active` out entirely, so no active node was ever
  // checked against the list and a lapsed registration could never be detected.
  assert.equal(
    await reportedOnList({ host: "1.2.3.4", apiPort: 16127, absent: true, status: "active" }),
    false
  );
});
