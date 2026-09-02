import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAll, renderReadme, type Answers } from "./scaffold";

/**
 * README.txt — the directory explaining itself.
 *
 * Supporters are node operators, not distributed-systems engineers, and the runbook is
 * a thousand lines that assume you are mid-onboarding while you read it. This is what
 * you want three weeks later when something is down and you have forgotten which command
 * reloads the environment.
 *
 * Two properties it must never lose: it holds NO secrets (so it can be pasted into a
 * support thread), and it never recommends `restart`.
 */

const BASE: Answers = {
  providerSlug: "acme-nodes",
  providerName: "Acme Nodes",
  ownerAddress: "t1ownerWallet",
  mtBaseUrl: "https://fluxhub.moltentech.us",
  fluxAppName: "coalition-acme",
  hosts: [
    {
      name: "pve-01",
      storageImages: "ssd",
      storageIso: "iso-store",
      slots: [
        { tier: "cumulus", vmName: "ac-c1", ipAddress: "203.0.113.10", lanIp: "192.168.1.10/24", gateway: "192.168.1.1", apiPort: 16127 },
        { tier: "cumulus", vmName: "ac-c2", ipAddress: "203.0.113.10", lanIp: "192.168.1.11/24", gateway: "192.168.1.1", apiPort: 16137 },
      ],
    },
  ],
};

const operator: Answers = { ...BASE, level: "operator", tierPricesCents: { cumulus: 700 } };
const supporter: Answers = { ...BASE, level: "supporter" };

test("init writes it", () => {
  assert.equal(generateAll(operator)["README.txt"], renderReadme(operator));
});

test("⭐ it contains NO secret, so it is safe to paste when asking for help", () => {
  // The one generated file with that property. Everything interpolated must be public:
  // slug, app name, URLs, host names.
  const withSecrets: Answers = {
    ...operator,
    proxmoxTokenSecret: "11111111-2222-3333-4444-555555555555",
    stripeSecretKey: "rk_live_SHOULD_NEVER_APPEAR",
    stripeWebhookSecret: "whsec_SHOULD_NEVER_APPEAR",
    sessionSecret: "f".repeat(64),
  };
  const text = renderReadme(withSecrets);
  for (const secret of [
    "11111111-2222-3333-4444-555555555555",
    "rk_live_SHOULD_NEVER_APPEAR",
    "whsec_SHOULD_NEVER_APPEAR",
    "f".repeat(64),
  ]) {
    assert.ok(!text.includes(secret), `README.txt leaked ${secret.slice(0, 12)}…`);
  }
});

test("⭐ it never tells you to use `restart`, which silently keeps the old settings", () => {
  const text = renderReadme(operator);
  assert.match(text, /--force-recreate/);
  // Named only to warn about it, never as an instruction.
  assert.doesNotMatch(text, /^\s+docker compose restart\s*$/m);
  assert.match(text, /does not re-read your settings/);
});

test("it says which half runs where — the thing that is actually confusing", () => {
  const text = renderReadme(operator);
  assert.match(text, /THE AGENT runs HERE/);
  assert.match(text, /THE COALITION runs on the FLUX NETWORK, not here/);
  assert.match(text, /https:\/\/coalition-acme\.app\.runonflux\.io/);
});

test("a Supporter is not told to manage prices they do not have", () => {
  assert.doesNotMatch(renderReadme(supporter), /a PRICE/);
  assert.match(renderReadme(operator), /Changing a PRICE/);
  assert.match(renderReadme(supporter), /You are a Flux Hub Supporter/);
});

test("⭐ it stays a one-screen card, not a second copy of the file reference", () => {
  // Its job is the reminder you want three weeks later: who you are, how to start and
  // stop the agent, what usually breaks. What each file IS lives in
  // docs/FluxHub-overview.md, and a README that drifts back into duplicating it is one
  // nobody reads to the end of.
  for (const a of [operator, supporter]) {
    const lines = renderReadme(a).split("\n").length;
    assert.ok(lines <= 100, `README.txt has grown to ${lines} lines`);
  }
  assert.match(renderReadme(operator), /fh-toolkit\.md/);
  assert.match(renderReadme(operator), /FluxHub-overview\.md/);
});

test("it warns about the two unrecoverable losses, in the operator's own terms", () => {
  const text = renderReadme(operator);
  assert.match(text, /Deleting manifest-key\.pem/);
  assert.match(text, /BACK IT UP/);
  // The one that actually happened, 2026-08-23.
  assert.match(text, /init --force/);
  assert.match(text, /erases the three keys/);
});

test("it fits an 80-column terminal, which is where it will be read", () => {
  for (const a of [operator, supporter]) {
    for (const line of renderReadme(a).split("\n")) {
      assert.ok(line.length <= 78, `too wide (${line.length}): ${line}`);
    }
  }
});

test("it names this provider, not a placeholder", () => {
  const text = renderReadme(operator);
  assert.match(text, /Acme Nodes/);
  assert.match(text, /acme-nodes/);
  assert.match(text, /2 slot\(s\) on pve-01/);
});
