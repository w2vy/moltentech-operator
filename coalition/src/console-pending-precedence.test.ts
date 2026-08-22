/**
 * Two pending items for ONE slot must not silently invert MT's precedence rule.
 *
 * `pending` is a `Map` keyed by slotId. MT sends its two populations in precedence order —
 * cancel-driven deletes first, then outstanding `awaiting_auth` requests — and documents that a
 * cancellation OUTRANKS a request: "the customer's decision to stop paying beats an operational
 * request, and reprovisioning a node being torn down is meaningless work" (`listPendingAuth`).
 *
 * `Map.set` keeps the LAST write. So a duplicate slotId did not merely collapse two items into
 * one — it kept the WRONG one, presenting the operator a `reprovision` for a node the customer is
 * cancelling while hiding the teardown they actually needed to sign.
 *
 * Nothing else can catch this. MT dedupes today, but the collapse is structurally invisible from
 * MT (the map just holds fewer entries; the push still returns 200) and the DB constraint cannot
 * express it: only one `awaiting_auth` row ever exists per slot, and the cancel-driven population
 * has no row at all. Found by inspection during horizon C-work, 2026-08-22.
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
import { handleAgentPending, handleConsoleIndex } from "./console";
import type { CoalitionConfig } from "./config";

const SLUG = "precedence-test";
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
    sessionSecret: "secret",
    sessionTtlMs: 3600_000,
    tierPrices: {},
    trialDays: 1,
    statsWindowDays: 30,
    fluxApiUrl: "https://api.runonflux.io",
  } as CoalitionConfig;
}

function push(items: unknown[]): { status: number; body: string } {
  const body = Buffer.from(JSON.stringify({ items }));
  const issuedAt = new Date().toISOString();
  const nonce = randomBytes(16).toString("hex");
  const signature = signRequest(
    { method: "POST", path: "/agent/pending", slug: SLUG, issuedAt, nonce, bodyHash: bodyHash(body) },
    agent.privateKey
  );
  const res = handleAgentPending(cfg(), body, {
    [HEADER_AGENT_SIGNATURE]: signature,
    [HEADER_AGENT_TIMESTAMP]: issuedAt,
    [HEADER_AGENT_NONCE]: nonce,
    [HEADER_AGENT_SLUG]: SLUG,
  } as never);
  return { status: res.status, body: res.body as string };
}

const cancelDelete = {
  slotId: "slot-dup",
  action: "delete",
  providerSlug: SLUG,
  vmName: "mt-187-c9",
  nodeName: "pve30",
  rentalCode: "MT-7777",
};
const staleReprovision = { ...cancelDelete, action: "reprovision", rentalCode: "MT-6666" };

test("a duplicate slotId keeps the FIRST item — MT's precedence order — not the last", () => {
  const res = push([cancelDelete, staleReprovision]);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).pending, 1, "the two items must collapse to one");

  // Assert on the rendered BADGE, not the page: the stylesheet defines `.badge-reprovision`
  // unconditionally, so a document-wide match would pass on CSS and prove nothing.
  const page = handleConsoleIndex(cfg()).body as string;
  const badge = (action: string) => `<span class="badge badge-${action}">${action}</span>`;
  assert.ok(page.includes(badge("delete")), "the cancel-driven delete must survive");
  assert.ok(
    !page.includes(badge("reprovision")),
    "the reprovision outranked by a cancellation must NOT be what the operator is offered"
  );
});

test("a collapse is REPORTED rather than swallowed", () => {
  const res = push([cancelDelete, staleReprovision]);
  const parsed = JSON.parse(res.body) as { pending: number; collapsed?: number };
  assert.equal(parsed.collapsed, 1, "the push must say it dropped an item");
});

test("the ordinary case is unchanged and reports no collapse", () => {
  const res = push([cancelDelete, { ...cancelDelete, slotId: "slot-other", action: "reprovision" }]);
  const parsed = JSON.parse(res.body) as { pending: number; collapsed?: number };
  assert.equal(parsed.pending, 2);
  assert.equal(parsed.collapsed, undefined, "no `collapsed` key when nothing collapsed");
});

test("another provider's items are still dropped, and do not count as a collapse", () => {
  const res = push([cancelDelete, { ...cancelDelete, providerSlug: "someone-else" }]);
  const parsed = JSON.parse(res.body) as { pending: number; collapsed?: number };
  assert.equal(parsed.pending, 1);
  assert.equal(parsed.collapsed, undefined, "a foreign-provider item is a filter, not a collapse");
});
