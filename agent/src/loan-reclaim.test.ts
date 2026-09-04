import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SCHEMA_VERSION } from "@moltentech/protocol";
import type { LoanRequest } from "@moltentech/protocol";
import { generateEd25519 } from "@moltentech/protocol/signing";
import { signLoanRequest } from "@moltentech/protocol/loan-signing";
import type { LoanScanResult } from "./loan-scan";
import { reclaimPlan, shouldReclaim, type ReclaimRefusal } from "./loan-reclaim";

// ⚠️ This is the ONE autonomous delete in the loan design. There is no hub job, no operator
// signature and no reviewer behind it, and a wrong answer destroys a node belonging to the
// BORROWER's paying customer. So the table below is deliberately exhaustive over the states a
// scan can produce — the point is not coverage, it is that every way of reaching `reclaim: true`
// is written down somewhere a human can read it.

const borrower = generateEd25519();

function req(over: Partial<LoanRequest> = {}): LoanRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    borrowerSlug: "moltentech-test1",
    lenderSlug: "moltentech",
    offerRevision: 3,
    borrows: [{ vmName: "mt-187-c4", nodeName: "pve45", durationHours: 24 }],
    issuedAt: "2026-09-04T12:00:00.000Z",
    nonce: "unsigned",
    ...over,
  };
}

function live(over: { vmName?: string; borrowerSlug?: string; expired?: boolean } = {}): LoanScanResult {
  const vmName = over.vmName ?? "mt-187-c4";
  const borrowerSlug = over.borrowerSlug ?? "moltentech-test1";
  return {
    vmName,
    nodeName: "pve45",
    verdict: {
      loan: true,
      request: signLoanRequest(
        req({ borrowerSlug, borrows: [{ vmName, nodeName: "pve45", durationHours: 24 }] }),
        borrower.privateKey
      ),
      provisionedAt: new Date("2026-09-04T12:00:00.000Z"),
      expiresAt: new Date("2026-09-05T12:00:00.000Z"),
      expired: over.expired ?? true,
    },
  };
}

function refused(reason: string): LoanScanResult {
  return {
    vmName: "mt-187-c4",
    nodeName: "pve45",
    verdict: { loan: false, reason: reason as never },
  };
}

const NONE: ReadonlySet<string> = new Set();

// ── the one YES ───────────────────────────────────────────────────────────────

test("an expired, verified, in-limit loan is reclaimed", () => {
  const v = shouldReclaim(live(), NONE);
  assert.equal(v.reclaim, true);
  if (!v.reclaim) return;
  assert.equal(v.borrowerSlug, "moltentech-test1");
  assert.equal(v.expiresAt.toISOString(), "2026-09-05T12:00:00.000Z");
});

// ── every NO ──────────────────────────────────────────────────────────────────

test("a live loan inside its term is NOT reclaimed", () => {
  assert.deepEqual(shouldReclaim(live({ expired: false }), NONE), {
    reclaim: false,
    reason: "not-expired",
  });
});

test("every scan refusal is 'not-a-loan' — a VM whose stamp did not verify is never touched", () => {
  // The exhaustive part: whatever readLoanState refused for, it never reaches a delete.
  const reasons = [
    "not-leased",
    "no-record",
    "not-json",
    "schema",
    "bad-signature",
    "wrong-lender",
    "wrong-borrower",
    "unknown-offer-revision",
    "slot-not-offered",
    "stamp-names-another-vm",
    "no-ctime",
    "too-stale",
  ];
  for (const reason of reasons) {
    const v = shouldReclaim(refused(reason), NONE);
    assert.deepEqual(v, { reclaim: false, reason: "not-a-loan" as ReclaimRefusal }, reason);
  }
});

test("a borrower over the concurrency limit has NOTHING reclaimed, expired or not", () => {
  // A breach means an upstream fence failed, so the agent's picture of the world is known to be
  // wrong — the worst possible moment to fire the design's only autonomous delete.
  const breached = new Set(["moltentech-test1"]);
  assert.deepEqual(shouldReclaim(live(), breached), {
    reclaim: false,
    reason: "concurrency-breach",
  });
  assert.deepEqual(shouldReclaim(live({ expired: false }), breached), {
    reclaim: false,
    reason: "concurrency-breach",
  });
});

test("a breach by ONE borrower does not shield another borrower's expired loan", () => {
  const breached = new Set(["moltentech-test1"]);
  const other = live({ vmName: "mt-187-c5", borrowerSlug: "moltentech-test2" });
  assert.equal(shouldReclaim(other, breached).reclaim, true);
});

test("the breach check runs BEFORE expiry, so it reports on running loans too", () => {
  // Reported while there is still time to fix the offer set, not only once a term ends.
  const v = shouldReclaim(live({ expired: false }), new Set(["moltentech-test1"]));
  assert.equal(v.reclaim === false && v.reason, "concurrency-breach");
});

// ── the whole fleet at once ───────────────────────────────────────────────────

test("reclaimPlan decides every VM against ONE shared breach set", () => {
  // Sharing the set is the point: a per-VM decision that recomputed it could disagree with
  // itself between two VMs of the same borrower.
  const results = [
    live({ vmName: "mt-187-c4" }),
    live({ vmName: "mt-187-c5", expired: false }),
    live({ vmName: "mt-187-c6", borrowerSlug: "moltentech-test2" }),
    refused("bad-signature"),
  ];
  const plan = reclaimPlan(results, new Set(["moltentech-test1"]));
  assert.deepEqual(
    plan.map((p) => (p.verdict.reclaim ? "RECLAIM" : p.verdict.reason)),
    ["concurrency-breach", "concurrency-breach", "RECLAIM", "not-a-loan"]
  );
});

test("an empty scan plans nothing", () => {
  assert.deepEqual(reclaimPlan([], NONE), []);
});
