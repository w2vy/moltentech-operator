/**
 * A Foundation (idle-fill) node must READ as "not a customer" on the console.
 *
 * It carries a normal-looking `MT-####` rental code, so without a badge the operator sees
 * a paying tenant. The badge is derived HERE from `FOUNDATION_VM_PREFIX` on the VM name —
 * never from a flag MT sends — because a spoofable "no customer" label is a lever for
 * getting an operator to sign away a real customer's node. These tests pin both halves:
 * the badge appears for an `fh-` VM, and a customer's node is untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { generateEd25519, signRequest, bodyHash } from "@moltentech/protocol/signing";
import {
  HEADER_AGENT_SIGNATURE,
  HEADER_AGENT_TIMESTAMP,
  HEADER_AGENT_NONCE,
  HEADER_AGENT_SLUG,
  FOUNDATION_VM_PREFIX,
} from "@moltentech/protocol";
import { handleAgentState, handleConsoleIndex } from "./console";
import type { CoalitionConfig } from "./config";

const SLUG = "badge-test";
const agent = generateEd25519();

function cfg(): CoalitionConfig {
  return {
    port: 8088,
    providerSlug: SLUG,
    mtBaseUrl: "https://mt.example",
    agentKey: "agent-key",
    coalitionKey: "bearer",
    stripeSecretKey: "sk_test",
    stripeWebhookSecret: "whsec",
    manifestPath: "./manifest.json",
    manifestJson: JSON.stringify({ providerSlug: SLUG, pubkey: agent.publicKeyBase64 }),
    ownerAddress: "t1exampleOwnerWalletAddress",
    // Set: the badge lives in the Nodes table, which the CV6 read-gate withholds entirely
    // when SESSION_SECRET is unset (console-state-gate.test.ts owns that property).
    sessionSecret: "a-session-secret",
    sessionTtlMs: 3600_000,
    tierPrices: {},
    trialDays: 1,
    statsWindowDays: 30,
    fluxApiUrl: "https://api.runonflux.io",
  } as CoalitionConfig;
}

function pushState(vmName: string, rentalCode: string): void {
  const body = Buffer.from(
    JSON.stringify({
      items: [{ nodeName: "pve50", vmName, tier: "cumulus", status: "active", rentalCode }],
    })
  );
  const issuedAt = new Date().toISOString();
  const nonce = randomBytes(16).toString("hex");
  const signature = signRequest(
    { method: "POST", path: "/agent/state", slug: SLUG, issuedAt, nonce, bodyHash: bodyHash(body) },
    agent.privateKey
  );
  const res = handleAgentState(cfg(), body, {
    [HEADER_AGENT_SIGNATURE]: signature,
    [HEADER_AGENT_TIMESTAMP]: issuedAt,
    [HEADER_AGENT_NONCE]: nonce,
    [HEADER_AGENT_SLUG]: SLUG,
  } as never);
  assert.equal(res.status, 200, "state push should be accepted");
}

test("an fh- node is badged, and its rental code is not presented as a customer's", () => {
  pushState(`${FOUNDATION_VM_PREFIX}ms-186-c8`, "MT-0036");
  const body = handleConsoleIndex(cfg()).body;

  assert.match(body, /Foundation node — no customer/);
  // The code is REPLACED, not merely annotated: leaving `MT-0036` in the rental column is
  // what made a fill indistinguishable from a tenancy in the first place.
  assert.ok(!body.includes("MT-0036"), "the rental code must not render for a Foundation node");
});

test("a customer's node keeps its rental code and gets no badge", () => {
  pushState("ms-186-c6", "MT-0033");
  const body = handleConsoleIndex(cfg()).body;

  assert.ok(body.includes("MT-0033"), "a real rental still shows its code");
  assert.ok(!body.includes("Foundation node — no customer"), "no badge on a customer's node");
});

test("the prefix match is case-insensitive", () => {
  // `foundationVmName()` lower-cases, but the agent re-asserts names from inventory.json
  // and a hand-edited one can arrive capitalised. The agent's own delete exemption is
  // case-insensitive for the same reason; a badge that is not would be strictly worse
  // than no badge — it would say "customer" about a node that has none.
  pushState("FH-ms-186-c8", "MT-0036");
  const body = handleConsoleIndex(cfg()).body;

  assert.match(body, /Foundation node — no customer/);
});
