import { test } from "node:test";
import assert from "node:assert/strict";
import { isIPv4, vmNameProblem, SLUG_RE } from "./scaffold";
import { FOUNDATION_VM_PREFIX } from "./messages";

/**
 * Answers are checked WHERE THEY ARE TYPED.
 *
 * Every rule below already existed in `validateAnswers` — which runs after the last
 * question and then `die()`s. So typing a VM name at the tier prompt (tom, 2026-08-23)
 * was accepted, and the wizard ran to the end before throwing away thirty answers over
 * one field. The rules did not need writing; they needed moving.
 */

test("⭐ an IPv4 address is four octets, and a hostname is not one", () => {
  // Flux binds the address itself. A hostname here produces a node that never answers,
  // and nothing in that failure mentions this prompt.
  for (const ok of ["47.206.56.187", "192.168.87.1", "10.0.0.1", "255.255.255.255"]) {
    assert.equal(isIPv4(ok), true, ok);
  }
  for (const bad of ["pve30", "47.206.56", "47.206.56.187.1", "47.206.56.999", "", "1.2.3.4/24", "::1"]) {
    assert.equal(isIPv4(bad), false, bad);
  }
});

test("⭐ a VM name in the Foundation namespace is refused HERE, not at ingest", () => {
  // The hub rejects the whole manifest for this. Caught at the prompt it costs one
  // retype; caught at ingest it costs a re-scaffold and a re-sign.
  const why = vmNameProblem(`${FOUNDATION_VM_PREFIX}mt-185-c9`)!;
  assert.match(why, /reserved for Foundation/);
  assert.match(why, /rejects the whole manifest/);
  assert.equal(vmNameProblem(`${FOUNDATION_VM_PREFIX.toUpperCase()}node`) !== undefined, true, "case does not evade it");
});

test("a VM name has to be a hostname", () => {
  assert.equal(vmNameProblem("mt1-187-c2"), undefined);
  assert.equal(vmNameProblem("node01"), undefined);
  for (const bad of ["", "-leading", "trailing-", "has space", "under_score", "dots.in.name"]) {
    assert.ok(vmNameProblem(bad), `${bad} should be refused`);
  }
});

test("a 63-character name passes and a 64-character one does not", () => {
  assert.equal(vmNameProblem("a".repeat(63)), undefined);
  assert.ok(vmNameProblem("a".repeat(64)));
});

test("the slug rule is the one validateAnswers enforces, exported so the prompt can use it", () => {
  // PERMANENT once ingested — the single worst field to discover a rule about at the end.
  assert.equal(SLUG_RE.test("acme-nodes"), true);
  assert.equal(SLUG_RE.test("Acme-Nodes"), false, "uppercase");
  assert.equal(SLUG_RE.test("-acme"), false, "leading hyphen");
  assert.equal(SLUG_RE.test("acme-"), false, "trailing hyphen");
  assert.equal(SLUG_RE.test("ab"), false, "too short");
});
