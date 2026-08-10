/**
 * The node dashboard must FAIL CLOSED when the CV6 read-gate is off.
 *
 * The Coalition is a public Flux App. With `SESSION_SECRET` unset there is no login
 * gate on `/console`, so anything the page renders is world-readable — and the Nodes
 * section carries node names, tiers, live slot status and the customer's rental code.
 * A coalition deployed without `SESSION_SECRET` published exactly that (found on
 * coalition-test1, 2026-08-10).
 *
 * These tests pin the property in both directions, because the failure is silent:
 * nothing errors, the page still renders, the data is just visible to everyone.
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
} from "@moltentech/protocol";
import { handleAgentState, handleConsoleIndex } from "./console";
import type { CoalitionConfig } from "./config";

const SLUG = "gate-test";
const agent = generateEd25519();

function cfg(sessionSecret?: string): CoalitionConfig {
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
    sessionSecret,
    sessionTtlMs: 3600_000,
    tierPrices: {},
    trialDays: 1,
    statsWindowDays: 30,
    fluxApiUrl: "https://api.runonflux.io",
  } as CoalitionConfig;
}

/** Push one node snapshot through the real manifest-signed ingest path. */
function pushState(): void {
  const body = Buffer.from(
    JSON.stringify({
      items: [
        {
          nodeName: "pve30",
          vmName: "mt-187-c1",
          tier: "cumulus",
          status: "active",
          rentalCode: "MT-9999",
        },
      ],
    })
  );
  const issuedAt = new Date().toISOString();
  const nonce = randomBytes(16).toString("hex");
  const signature = signRequest(
    { method: "POST", path: "/agent/state", slug: SLUG, issuedAt, nonce, bodyHash: bodyHash(body) },
    agent.privateKey
  );
  const res = handleAgentState(cfg("secret"), body, {
    [HEADER_AGENT_SIGNATURE]: signature,
    [HEADER_AGENT_TIMESTAMP]: issuedAt,
    [HEADER_AGENT_NONCE]: nonce,
    [HEADER_AGENT_SLUG]: SLUG,
  } as never);
  assert.equal(res.status, 200, "state push should be accepted");
}

test("console withholds node state when SESSION_SECRET is unset", () => {
  pushState();
  const body = handleConsoleIndex(cfg(undefined)).body;

  // The leak that matters: none of the pushed state may reach the page.
  assert.ok(!body.includes("MT-9999"), "rental code must not be rendered");
  assert.ok(!body.includes("mt-187-c1"), "vm name must not be rendered");
  assert.ok(!body.includes("pve30"), "node name must not be rendered");

  // …and the operator is told why, so a missing table isn't mistaken for a bug.
  assert.match(body, /SESSION_SECRET/);

  // The page itself must still work: actions are individually signature-gated and
  // are the operator's only route to authorize work.
  assert.match(body, /Actions awaiting your signature/);
});

test("console renders node state once SESSION_SECRET is set", () => {
  pushState();
  const body = handleConsoleIndex(cfg("a-session-secret")).body;

  assert.ok(body.includes("mt-187-c1"), "vm name should render behind the gate");
  assert.ok(body.includes("pve30"), "node name should render behind the gate");
  assert.ok(body.includes("MT-9999"), "rental code should render behind the gate");
});
