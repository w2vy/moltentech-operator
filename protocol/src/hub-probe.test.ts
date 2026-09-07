import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { probeHub, type HubHttp } from "./hub-probe";
import type { ProbeResult } from "./proxmox-probe";

/**
 * These reproduce the 2026-08-23 near-miss: three keys re-issued by an admin, a Coalition
 * still running the environment it was deployed with, and every passive signal green —
 * `doctor` clean, manifest served, `lastSyncedAt` ticking. The probe's whole job is to be
 * the first thing that goes red, so the tests assert on the JUDGEMENT of each status code,
 * not on the network.
 *
 * The status codes below are not invented: measured on prod against `moltentech-test1`
 * (agent 200; coalition 400 with the real key, 401 with a deliberately wrong one).
 */

const MT = "https://fluxhub.moltentech.us";
const COALITION = "https://coalition-test1.app.runonflux.io";
const PUBKEY = "Zm9vYmFyYmF6cXV1eA==";

const AGENT_STATE = JSON.stringify({
  slots: [{ vmName: "mt1-187-c2" }, { vmName: "mt1-187-c3" }],
});
const SIGNED = JSON.stringify({ pubkey: PUBKEY, signature: "sigAAA", slug: "moltentech-test1" });

/** A hub + Coalition that are entirely in step. Override one route to break one thing. */
function fakeHttp(overrides: Record<string, { status: number; text?: string; headers?: Record<string, string> }> = {}): HubHttp {
  const routes: Record<string, { status: number; text?: string; headers?: Record<string, string> }> = {
    [`GET ${MT}/api/agent/state`]: { status: 200, text: AGENT_STATE },
    [`POST ${COALITION}/checkout`]: { status: 400, text: '{"error":"Invalid checkout request"}' },
    [`GET ${COALITION}/.well-known/mt-provider.json`]: { status: 200, text: SIGNED },
    [`GET ${COALITION}/health`]: { status: 200, text: '{"ok":true,"coalitionVersion":"0.2.8"}' },
    ...overrides,
  };
  return async (req) => {
    const hit = routes[`${req.method} ${req.url}`];
    if (!hit) throw new Error(`unexpected request: ${req.method} ${req.url}`);
    // A real Coalition stamps X-Coalition-Version on EVERY response, before routing —
    // so a fixture without it is a fixture of something that is not the Coalition.
    // Routes that mean to be that (Flux's edge 503) set `headers` explicitly.
    const headers =
      hit.headers ?? (req.url.startsWith(COALITION) ? { "x-coalition-version": "0.2.8" } : {});
    return { status: hit.status, text: hit.text ?? "", headers };
  };
}

// Phase E step 4: the probe signs with MANIFEST_KEY instead of presenting a bearer, so
// the fixture needs a real key — the base64 of a PKCS#8 PEM, exactly as secrets.env holds it.
const MANIFEST_KEY = Buffer.from(
  generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string
).toString("base64");

const INPUT = {
  mtBaseUrl: MT,
  coalitionUrl: COALITION,
  manifestKey: MANIFEST_KEY,
  providerSlug: "pve25-lab",
  localPubkey: PUBKEY + "\n",
  localManifestJson: SIGNED,
};

const rules = (fs: { rule: string }[]) => fs.map((f) => f.rule).sort();
const check = (checks: ProbeResult[], needle: string) => checks.find((c) => c.name.includes(needle))!;

test("a fully in-step operator: nothing to report, and the slot list is echoed back", async () => {
  const { checks, findings } = await probeHub(INPUT, fakeHttp());
  assert.deepEqual(findings, []);
  // "Coalition inbound auth" is a permanent skip since Phase E step 4 — the operator
  // cannot sign as Flux Hub — so `every(pass)` is no longer the right assertion. Nothing
  // may FAIL, and every check that can still be performed must pass.
  assert.equal(checks.filter((c) => c.status === "fail").length, 0, checks.map((c) => `${c.name}:${c.status}`).join(" "));
  assert.deepEqual(
    checks.filter((c) => c.status === "skip").map((c) => c.name),
    ["Coalition inbound auth"]
  );
  assert.match(check(checks, "MANIFEST_KEY").detail, /sees 2 slot\(s\): mt1-187-c2, mt1-187-c3/);
  assert.match(check(checks, "build").detail, /0\.2\.8/);
});

test("⭐ Flux Hub rejecting the SIGNATURE is an ERROR that names the unauthenticated stats pull", async () => {
  // The reason this needs saying: the operator's evidence that "everything is fine" is
  // the provider page, and the provider page is fed by a GET that carries no key at all.
  const { checks, findings } = await probeHub(INPUT, fakeHttp({ [`GET ${MT}/api/agent/state`]: { status: 401 } }));
  assert.deepEqual(rules(findings), ["MANIFEST_KEY_REJECTED"]);
  assert.equal(findings[0]!.severity, "error");
  assert.match(findings[0]!.message, /unauthenticated/);
  assert.equal(check(checks, "MANIFEST_KEY").status, "fail");
});

// ── Phase E step 4, 2026-09-07 ────────────────────────────────────────────────────────
// Four tests lived here covering the `COALITION_KEY` bearer probe against the deployed
// Coalition. That probe is gone: inbound /checkout now accepts only a Flux Hub signature,
// which the operator does not hold and must never hold. It is not a check that regressed,
// it is one that stopped being the operator's to run.
//
// Worth keeping from what they proved, because it cost a real measurement:
//   - A Coalition that was never deployed answers every route with FLUX'S OWN edge page
//     (`Error 503 FDM-USA-1-1`, text/html, no `x-coalition-version`). 503 sits on the
//     accept side of a 401/not-401 split, so a naive probe read an UNDEPLOYED app as an
//     accepted key — the one direction such a check must never fail in. Only the
//     `x-coalition-version` header separates the app from the edge.
// That lesson now lives on check 3, which is the one still asking the Coalition anything.

test("🔒 the deployed-Coalition auth check is SKIPPED, and says whose signature it needs", async () => {
  const { checks, findings } = await probeHub(INPUT, fakeHttp());
  assert.deepEqual(findings, []);
  const c = check(checks, "Coalition inbound auth");
  assert.equal(c.status, "skip");
  assert.match(c.detail, /Flux Hub signature/);
  // Must not read as a pass. A skip that looks like a tick is how a missing check becomes
  // invisible — the operator needs to know this ground is no longer covered here.
  assert.notEqual(c.status, "pass");
});

test("a trailing slash on either URL does not produce a doubled path", async () => {
  const { findings } = await probeHub(
    { ...INPUT, mtBaseUrl: `${MT}/`, coalitionUrl: `${COALITION}/` },
    fakeHttp()
  );
  assert.deepEqual(findings, []); // fakeHttp throws on any unexpected path
});
