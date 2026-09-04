import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION } from "./common";
import type { LoanOffer } from "./loan";
import { generateEd25519, exportPrivateKeyPem } from "./signing";
import { signLoanOffer, verifyLoanStamp } from "./loan-signing";
import { joinSignedRecord } from "./signed-record";

// `mt-manifest borrow` is the ONLY way a borrower produces a LoanRequest, and every one of its
// refusals describes something the operator cannot see from their own side. So these drive the
// real CLI: a unit test of `acceptOffer` cannot catch a mis-wired flag, a wrong default path, or
// a refusal that exits 0.

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mt-borrow-"));

const lender = generateEd25519();
const borrower = generateEd25519();
const KEY = join(dir, "manifest-key.pem");
writeFileSync(KEY, exportPrivateKeyPem(borrower.privateKey));

const OFFER: LoanOffer = {
  schemaVersion: SCHEMA_VERSION,
  revision: 3,
  lenderSlug: "moltentech",
  borrowerSlug: "moltentech-test1",
  borrowerPubkey: borrower.publicKeyBase64,
  slots: [{ vmName: "mt-187-c4", nodeName: "pve45", tier: "cumulus" }],
  maxDurationHours: 48,
  maxConcurrent: 1,
  offerExpiresAt: "2099-01-01T00:00:00.000Z",
  issuedAt: "2026-09-04T00:00:00.000Z",
  nonce: "offer-1",
};
const OFFER_PATH = join(dir, "offer.json");
writeFileSync(OFFER_PATH, JSON.stringify(signLoanOffer(OFFER, lender.privateKey), null, 2));

/**
 * `flag()` takes the FIRST occurrence, so a duplicate flag never overrides — the pubkey is a
 * parameter here rather than something a caller appends.
 */
function run(
  extra: string[],
  lenderPubkey = lender.publicKeyBase64
): { out: string; err: string; code: number } {
  // spawnSync, not execFileSync, so the two streams stay separable: `borrow` now writes a
  // deprecation notice to stderr while stdout must remain the signed record and nothing else.
  // `out` keeps its original meaning — merged on failure, so the refusal assertions below read
  // the same as they always did — and `err` is stderr alone.
  const r = spawnSync(
    "npx",
    [
      "tsx", CLI, "borrow",
      "--offer", OFFER_PATH,
      "--lender-pubkey", lenderPubkey,
      "--key", KEY,
      "--slug", "moltentech-test1",
      ...extra,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const code = r.status ?? 1;
  return { out: code === 0 ? stdout : `${stdout}${stderr}`, err: stderr, code };
}

test("borrow emits a signed LoanRequest that the lender's verifier accepts", () => {
  const r = run(["--vm", "mt-187-c4", "--node", "pve45", "--hours", "24", "--stdout"]);
  assert.equal(r.code, 0);
  const signed = JSON.parse(r.out);
  assert.equal(signed.offerRevision, 3);
  assert.equal(signed.lenderSlug, "moltentech");
  assert.match(signed.nonce, /^[0-9a-f]{32}$/);

  // The real acceptance path: the record as it lands in a VM description, read back.
  const description = joinSignedRecord("# flux-hub\nkind:     loaned", JSON.stringify(signed));
  const v = verifyLoanStamp(description, borrower.publicKeyBase64);
  assert.equal(v.ok, true);
});

test("--stamp prints exactly the bytes that go under the delimiter", () => {
  const r = run(["--vm", "mt-187-c4", "--node", "pve45", "--hours", "24", "--stamp"]);
  assert.equal(r.code, 0);
  const record = r.out.trimEnd();
  const v = verifyLoanStamp(
    joinSignedRecord("# flux-hub", record),
    borrower.publicKeyBase64
  );
  assert.equal(v.ok, true);
});

test("it writes to a file by default and reports the terms it agreed to", () => {
  const out = join(dir, "req.json");
  const r = run(["--vm", "mt-187-c4", "--node", "pve45", "--hours", "24", "--out", out]);
  assert.equal(r.code, 0);
  assert.match(r.out, /24h of an allowed 48h/);
  assert.match(r.out, /offer rev3/);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).offerRevision, 3);
});

test("a wrong lender pubkey FAILS — it does not quietly sign anyway", () => {
  const stranger = generateEd25519();
  const r = run(
    ["--vm", "mt-187-c4", "--node", "pve45", "--hours", "24", "--stdout"],
    stranger.publicKeyBase64
  );
  assert.notEqual(r.code, 0);
  assert.match(r.out, /signature does not check out/);
});

test("asking for longer than the offer allows fails with the ceiling named", () => {
  const r = run(["--vm", "mt-187-c4", "--node", "pve45", "--hours", "72", "--stdout"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /longer than the offer allows/);
});

test("a slot the offer never put up fails", () => {
  const r = run(["--vm", "mt-187-c9", "--node", "pve45", "--hours", "24", "--stdout"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not one this offer puts up/);
});

test("a non-integer --hours is rejected before any crypto happens", () => {
  const r = run(["--vm", "mt-187-c4", "--node", "pve45", "--hours", "24.5", "--stdout"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /positive whole number/);
});

test("borrow appears in the usage line", () => {
  // Bare invocation — `run()` always supplies a subcommand, so help is never reached through it.
  const out = execFileSync("npx", ["tsx", CLI, "--help"], { encoding: "utf8" });
  assert.match(out, /^usage: mt-manifest .*\|borrow\|/m);
});

test("help marks borrow DEPRECATED and names the console that replaces it", () => {
  // The deprecation has to be visible where an operator meets the command, not only in the plan.
  const out = execFileSync("npx", ["tsx", CLI, "--help"], { encoding: "utf8" });
  assert.match(out, /borrow\s+⚠️ DEPRECATED/);
  assert.match(out, /hub\/operator console/);
});

test("the deprecation notice goes to STDERR, leaving --stamp pipeable", () => {
  // 🔴 The whole point of the stream choice. `--stamp` output is written straight into a VM's
  // Proxmox description, and the 2026-09-04 staging run piped it to a file. A warning on stdout
  // would corrupt the signed record with prose and fail verification on the lender's agent, with
  // nothing in the failure pointing at a help string.
  const r = run(["--vm", "mt-187-c4", "--node", "pve45", "--hours", "24", "--stamp"]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /DEPRECATED/);
  assert.match(r.err, /DEPRECATED/);
  JSON.parse(r.out.trim()); // stdout is the record and nothing else
});

// ── reproducibility (--issued-at) ─────────────────────────────────────────────

test("without --issued-at, two runs produce DIFFERENT records", () => {
  // Not a bug — it is why the flag exists. `issuedAt` is the one field that comes from the
  // clock, and the nonce is content-derived, so it is what the loan identity turns on.
  const a = JSON.parse(run(["--vm", "mt-187-c4", "--node", "pve45", "--hours", "24", "--stdout"]).out);
  const b = JSON.parse(run(["--vm", "mt-187-c4", "--node", "pve45", "--hours", "24", "--stdout"]).out);
  assert.notEqual(a.issuedAt, b.issuedAt);
  assert.notEqual(a.nonce, b.nonce);
});

test("with --issued-at, the record is byte-for-byte reproducible", () => {
  const args = [
    "--vm", "mt-187-c4", "--node", "pve45", "--hours", "24", "--stdout",
    "--issued-at", "2026-09-04T12:00:00.000Z",
  ];
  const a = run(args);
  const b = run(args);
  assert.equal(a.code, 0);
  assert.equal(a.out, b.out);
  assert.equal(JSON.parse(a.out).issuedAt, "2026-09-04T12:00:00.000Z");
});

test("the success message tells you how to reproduce the bytes you just sent", () => {
  const out = join(dir, "repro.json");
  const r = run(["--vm", "mt-187-c4", "--node", "pve45", "--hours", "24", "--out", out]);
  assert.equal(r.code, 0);
  assert.match(r.out, /rerun with --issued-at 20\d\d-/);
});

test("a nonsense --issued-at is refused, not silently coerced", () => {
  const r = run([
    "--vm", "mt-187-c4", "--node", "pve45", "--hours", "24", "--stdout",
    "--issued-at", "last tuesday",
  ]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /ISO-8601/);
});
