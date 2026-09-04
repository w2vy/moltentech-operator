import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SCHEMA_VERSION, joinSignedRecord, type LoanOffer, type LoanRequest } from "@moltentech/protocol";
import { generateEd25519 } from "@moltentech/protocol/signing";
import { loanStampRecord, signLoanRequest } from "@moltentech/protocol/loan-signing";
import type { AgentConfig } from "./config";
import type { OwnedVm } from "./health";
import { overConcurrencyLimit, scanLoans, type LoanScanResult } from "./loan-scan";

const HEADER = "# flux-hub\nkind:     loaned";
const borrower = generateEd25519();

const OFFER: LoanOffer = {
  schemaVersion: SCHEMA_VERSION,
  revision: 3,
  lenderSlug: "moltentech",
  borrowerSlug: "moltentech-test1",
  borrowerPubkey: borrower.publicKeyBase64,
  slots: [
    { vmName: "mt-187-c4", nodeName: "pve45", tier: "cumulus" },
    { vmName: "mt-187-c5", nodeName: "pve45", tier: "cumulus" },
  ],
  maxDurationHours: 48,
  maxConcurrent: 1,
  offerExpiresAt: "2026-09-10T00:00:00.000Z",
  issuedAt: "2026-09-04T00:00:00.000Z",
  nonce: "offer-1",
};

function request(vmName: string, nonce: string): LoanRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    borrowerSlug: "moltentech-test1",
    lenderSlug: "moltentech",
    offerRevision: 3,
    borrows: [{ vmName, nodeName: "pve45", durationHours: 24 }],
    issuedAt: "2026-09-04T12:00:00.000Z",
    nonce,
  };
}

function stampFor(vmName: string, nonce = "n-1"): string {
  return joinSignedRecord(HEADER, loanStampRecord(signLoanRequest(request(vmName, nonce), borrower.privateKey)));
}

const CTIME = Math.floor(Date.UTC(2026, 8, 4, 12, 0, 0) / 1000);
const NOW = new Date(Date.UTC(2026, 8, 4, 20, 0, 0));

function ownedVm(over: Partial<OwnedVm> = {}): OwnedVm {
  return {
    vmName: "mt-187-c4",
    nodeName: "pve45",
    status: "running",
    tags: ["flux-hub", "loaned", "cumulus"],
    vmid: 219,
    ...over,
  };
}

/** A stand-in for the hypervisor: records what was asked for, answers from a fixture map. */
function fakeReader(configs: Record<string, { description?: string; meta?: string }>, calls: string[]) {
  return async (_cfg: AgentConfig, nodeName: string, vmid: number) => {
    calls.push(`${nodeName}/${vmid}`);
    const c = configs[`${nodeName}/${vmid}`];
    if (!c) throw new Error("proxmox 404");
    return c;
  };
}

const CFG = {} as AgentConfig;

test("a VM with no `loaned` chip costs ZERO config calls", async () => {
  const calls: string[] = [];
  const vms = [ownedVm({ tags: ["flux-hub", "paid", "cumulus"] })];
  const out = await scanLoans(CFG, vms, [OFFER], NOW, fakeReader({}, calls));
  assert.deepEqual(out, []);
  assert.deepEqual(calls, []);
});

test("a missing VM is skipped — the loan died with it", async () => {
  const calls: string[] = [];
  const vms = [ownedVm({ status: "missing", tags: [], vmid: null })];
  const out = await scanLoans(CFG, vms, [OFFER], NOW, fakeReader({}, calls));
  assert.deepEqual(out, []);
  assert.deepEqual(calls, []);
});

test("a loaned VM is read once and reported as a live loan", async () => {
  const calls: string[] = [];
  const reader = fakeReader(
    { "pve45/219": { description: stampFor("mt-187-c4"), meta: `creation-qemu=8.1.5,ctime=${CTIME}` } },
    calls
  );
  const out = await scanLoans(CFG, [ownedVm()], [OFFER], NOW, reader);
  assert.deepEqual(calls, ["pve45/219"]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.verdict.loan, true);
});

test("an unreachable hypervisor yields no verdict at all, not a refusal", async () => {
  // A node that will not answer is not evidence about a loan.
  const calls: string[] = [];
  const out = await scanLoans(CFG, [ownedVm()], [OFFER], NOW, fakeReader({}, calls));
  assert.deepEqual(out, []);
});

test("the most informative refusal survives, not the last offer's", async () => {
  // Two offers: one this stamp does not name (unknown-offer-revision), one it does but whose
  // borrower key is wrong (bad-signature). The second is what the operator needs to see.
  const calls: string[] = [];
  const impostor = generateEd25519();
  const reader = fakeReader(
    { "pve45/219": { description: stampFor("mt-187-c4"), meta: `creation-qemu=8.1.5,ctime=${CTIME}` } },
    calls
  );
  const wrongKey: LoanOffer = { ...OFFER, borrowerPubkey: impostor.publicKeyBase64 };
  const otherRevision: LoanOffer = { ...OFFER, revision: 9 };
  const out = await scanLoans(CFG, [ownedVm()], [wrongKey, otherRevision], NOW, reader);
  assert.equal(out[0]?.verdict.loan, false);
  if (out[0]?.verdict.loan === false) {
    assert.equal(out[0].verdict.reason, "bad-signature");
  }
});

test("with no offers at all, a loaned VM still reports — silence would hide it", async () => {
  const calls: string[] = [];
  const reader = fakeReader(
    { "pve45/219": { description: stampFor("mt-187-c4"), meta: `creation-qemu=8.1.5,ctime=${CTIME}` } },
    calls
  );
  const out = await scanLoans(CFG, [ownedVm()], [], NOW, reader);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.verdict.loan, false);
});

// ── concurrency (§7 step 4's set-level half) ──────────────────────────────────

function liveResult(vmName: string, borrowerSlug: string): LoanScanResult {
  return {
    vmName,
    nodeName: "pve45",
    verdict: {
      loan: true,
      request: { ...signLoanRequest(request(vmName, vmName), borrower.privateKey), borrowerSlug },
      provisionedAt: new Date(),
      expiresAt: new Date(),
      expired: false,
    },
  };
}

test("one borrower on one slot is within the limit", () => {
  assert.deepEqual(overConcurrencyLimit([liveResult("mt-187-c4", "moltentech-test1")]), []);
});

test("one borrower on two slots breaches the per-pair limit of 1", () => {
  const out = overConcurrencyLimit([
    liveResult("mt-187-c4", "moltentech-test1"),
    liveResult("mt-187-c5", "moltentech-test1"),
  ]);
  assert.deepEqual(out, [{ borrowerSlug: "moltentech-test1", count: 2 }]);
});

test("two borrowers on one slot each is fine — the limit is per PAIR", () => {
  assert.deepEqual(
    overConcurrencyLimit([
      liveResult("mt-187-c4", "moltentech-test1"),
      liveResult("mt-187-c5", "moltentech-test2"),
    ]),
    []
  );
});

test("refusals never count toward concurrency", () => {
  const refused: LoanScanResult = {
    vmName: "mt-187-c5",
    nodeName: "pve45",
    verdict: { loan: false, reason: "bad-signature" },
  };
  assert.deepEqual(
    overConcurrencyLimit([liveResult("mt-187-c4", "moltentech-test1"), refused]),
    []
  );
});
