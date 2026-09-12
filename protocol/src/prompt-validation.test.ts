import { test } from "node:test";
import assert from "node:assert/strict";
import { isIPv4, vmNameProblem, slugProblem, vmNamePrefixProblem, suggestVmNamePrefix, composeVmName, defaultVmNameSuffix } from "./scaffold";
import { ProviderSlug } from "./common";
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
  assert.equal(slugProblem("acme-nodes"), undefined);
  assert.ok(slugProblem("Acme-Nodes"), "uppercase");
  assert.ok(slugProblem("-acme"), "leading hyphen");
  assert.ok(slugProblem("acme-"), "trailing hyphen");
  assert.ok(slugProblem("ab"), "too short");
  assert.ok(slugProblem("a".repeat(41)), "too long");
});

test("⭐ the prompt rule IS the wire rule — a doubled hyphen is refused at the prompt", () => {
  // The old local regex accepted `a--b`; `ProviderSlug` refuses it. That gap let `init`
  // mint a PERMANENT slug the hub's ingest would reject, discovered at /onboard rather
  // than at the question. Any divergence here is the same bug returning.
  assert.ok(slugProblem("acme--nodes"), "doubled hyphen must be refused");
  for (const s of ["acme-nodes", "acme--nodes", "Acme", "-acme", "acme-", "ab", "a".repeat(41), "acme_nodes"]) {
    assert.equal(
      slugProblem(s) === undefined,
      ProviderSlug.safeParse(s).success,
      `slugProblem and ProviderSlug disagree about ${JSON.stringify(s)}`
    );
  }
});

test("vmNamePrefixProblem: the wire rule plus the one offline policy (Foundation's namespace)", () => {
  assert.equal(vmNamePrefixProblem("mt-"), undefined);
  assert.equal(vmNamePrefixProblem("mt1-"), undefined);
  assert.match(vmNamePrefixProblem("mt")!, /not a usable VM name prefix/);
  assert.match(vmNamePrefixProblem("mt")!, /PERMANENT/);
  assert.match(vmNamePrefixProblem("Mt-")!, /not a usable/);
  assert.match(vmNamePrefixProblem("mt-c-")!, /not a usable/);
  assert.match(vmNamePrefixProblem(`${FOUNDATION_VM_PREFIX}`)!, /reserved for Foundation nodes/);
});

test("suggestVmNamePrefix: the slug's initials, a default and nothing more", () => {
  assert.equal(suggestVmNamePrefix("acme-cloud"), "ac-");
  assert.equal(suggestVmNamePrefix("moltentech"), "mo-");
  assert.equal(suggestVmNamePrefix("a-b-c-d"), "abc-");
  // A one-letter slug cannot pass ProviderSlug (min 3), but the helper must still not
  // produce something the prompt then rejects.
  assert.equal(suggestVmNamePrefix("9lives"), "x9l-");
  // Whatever it suggests, it is always a prefix the prompt would accept.
  for (const slug of ["acme-cloud", "moltentech", "a-b-c-d", "x1", "9lives", "cute-dogs", "moltentech-test1"]) {
    assert.equal(vmNamePrefixProblem(suggestVmNamePrefix(slug)), undefined, slug);
  }
});

test("composeVmName / defaultVmNameSuffix produce today's mt-187-c2 shape", () => {
  assert.equal(composeVmName("mt-", defaultVmNameSuffix("187", 2)), "mt-187-c2");
  assert.equal(composeVmName("cd-", defaultVmNameSuffix("pve75", 1)), "cd-pve75-c1");
});
