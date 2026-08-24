import { test } from "node:test";
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

const MT = "https://www.moltentech.us";
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

const INPUT = {
  mtBaseUrl: MT,
  coalitionUrl: COALITION,
  agentKey: "agent-key",
  coalitionKey: "coalition-key",
  localPubkey: PUBKEY + "\n",
  localManifestJson: SIGNED,
};

const rules = (fs: { rule: string }[]) => fs.map((f) => f.rule).sort();
const check = (checks: ProbeResult[], needle: string) => checks.find((c) => c.name.includes(needle))!;

test("a fully in-step operator: nothing to report, and the slot list is echoed back", async () => {
  const { checks, findings } = await probeHub(INPUT, fakeHttp());
  assert.deepEqual(findings, []);
  assert.ok(checks.every((c) => c.status === "pass"), checks.map((c) => `${c.name}:${c.status}`).join(" "));
  assert.match(check(checks, "AGENT_KEY").detail, /sees 2 slot\(s\): mt1-187-c2, mt1-187-c3/);
  assert.match(check(checks, "build").detail, /0\.2\.8/);
});

test("⭐ Flux Hub rejecting AGENT_KEY is an ERROR that names the unauthenticated stats pull", async () => {
  // The reason this needs saying: the operator's evidence that "everything is fine" is
  // the provider page, and the provider page is fed by a GET that carries no key at all.
  const { checks, findings } = await probeHub(INPUT, fakeHttp({ [`GET ${MT}/api/agent/state`]: { status: 401 } }));
  assert.deepEqual(rules(findings), ["AGENT_KEY_REJECTED"]);
  assert.equal(findings[0]!.severity, "error");
  assert.match(findings[0]!.message, /unauthenticated/);
  assert.equal(check(checks, "AGENT_KEY").status, "fail");
});

test("⭐ a 401 from the DEPLOYED Coalition is the drift the probe exists for", async () => {
  // secrets.env is what you would paste into a NEW deploy; the running Flux app holds
  // whatever was imported when it was deployed. Nothing keeps those two in step.
  const { checks, findings } = await probeHub(
    INPUT,
    fakeHttp({ [`POST ${COALITION}/checkout`]: { status: 401, text: '{"error":"Unauthorized"}' } })
  );
  assert.deepEqual(rules(findings), ["COALITION_KEY_STALE_DEPLOY"]);
  assert.equal(findings[0]!.severity, "error");
  assert.match(findings[0]!.fix!, /mt-manifest env/);
  assert.equal(check(checks, "COALITION_KEY").status, "fail");
});

test("⭐ 400 is the PASS — auth ran before the body was parsed, so nothing was created", async () => {
  const { checks, findings } = await probeHub(INPUT, fakeHttp());
  assert.deepEqual(findings, []);
  assert.equal(check(checks, "COALITION_KEY").status, "pass");
  assert.match(check(checks, "COALITION_KEY").detail, /nothing created/);
});

test("503 payments-disabled also passes — a Supporter sells nothing and still has a key", async () => {
  const { checks, findings } = await probeHub(
    INPUT,
    fakeHttp({ [`POST ${COALITION}/checkout`]: { status: 503, text: '{"error":"payments disabled"}' } })
  );
  assert.deepEqual(findings, []);
  assert.equal(check(checks, "COALITION_KEY").status, "pass");
});

test("⭐ Flux's own 503 for an UNDEPLOYED app must not read as an accepted key", async () => {
  // Measured 2026-08-24: a Coalition that was never deployed answered every route with
  // Flux's edge page (`Error 503 FDM-USA-1-1`, text/html). 503 is on the accept side of
  // the 401/not-401 split, so the probe reported COALITION_KEY as ACCEPTED — the one
  // direction this check must never fail in. The header is what separates them: the edge
  // page has none, and a real Coalition sets it on 503 too.
  const { checks, findings } = await probeHub(
    INPUT,
    fakeHttp({
      [`POST ${COALITION}/checkout`]: {
        status: 503,
        text: "<html><head><title>Error 503 FDM-USA-1-1</title></head></html>",
        headers: {},
      },
    })
  );
  assert.deepEqual(findings, []);
  assert.equal(check(checks, "COALITION_KEY").status, "skip");
  assert.match(check(checks, "COALITION_KEY").detail, /unproven/);
  assert.doesNotMatch(check(checks, "COALITION_KEY").detail, /accepted/);
});

test("⭐ only 401 means rejected — a 403 must never send the operator to rotate a working key", async () => {
  // The lesson --check-stripe learned against restricted keys: anything other than 401
  // means the credential was ACCEPTED and something later went wrong.
  for (const status of [403, 500]) {
    const { findings } = await probeHub(INPUT, fakeHttp({ [`GET ${MT}/api/agent/state`]: { status } }));
    assert.deepEqual(findings, [], `status ${status} must not produce a key finding`);
  }
});

test("an unreachable hub is a SKIP that says validity is unproven, not a pass", async () => {
  const http: HubHttp = async (req) => {
    if (req.url.startsWith(MT)) throw new Error("getaddrinfo EAI_AGAIN www.moltentech.us");
    return fakeHttp()(req);
  };
  const { checks, findings } = await probeHub(INPUT, http);
  assert.deepEqual(findings, []);
  assert.equal(check(checks, "AGENT_KEY").status, "skip");
  assert.match(check(checks, "AGENT_KEY").detail, /unproven/);
});

test("⭐ a deployed manifest signed by ANOTHER key is an error, with head…tail keys", async () => {
  const other = JSON.stringify({ pubkey: "b3RoZXJrZXlvdGhlcmtleQ==", signature: "sigAAA" });
  const { checks, findings } = await probeHub(
    INPUT,
    fakeHttp({ [`GET ${COALITION}/.well-known/mt-provider.json`]: { status: 200, text: other } })
  );
  assert.deepEqual(rules(findings), ["COALITION_MANIFEST_WRONG_PUBKEY"]);
  assert.equal(findings[0]!.severity, "error");
  assert.match(findings[0]!.message, /…/, "keys are truncated head…tail, never head-only");
  assert.equal(check(checks, "deployed manifest").status, "fail");
});

test("same key, older signature = a re-sign that was never redeployed — a WARNING", async () => {
  // Nothing is broken; the listing customers see is simply not the one that was signed.
  const stale = JSON.stringify({ pubkey: PUBKEY, signature: "sigOLD" });
  const { findings } = await probeHub(
    INPUT,
    fakeHttp({ [`GET ${COALITION}/.well-known/mt-provider.json`]: { status: 200, text: stale } })
  );
  assert.deepEqual(rules(findings), ["COALITION_MANIFEST_STALE_DEPLOY"]);
  assert.equal(findings[0]!.severity, "warning");
});

test("keys not yet issued are SKIPPED and point at /onboard — this is not a failure", async () => {
  // The state of every operator between `init` and pasting the manifest. Reporting it as
  // an error would train them to ignore the report at the exact moment it starts mattering.
  const { checks, findings } = await probeHub(
    { ...INPUT, agentKey: undefined, coalitionKey: undefined },
    fakeHttp()
  );
  assert.deepEqual(findings, []);
  assert.equal(check(checks, "AGENT_KEY").status, "skip");
  assert.match(check(checks, "AGENT_KEY").detail, /onboard/);
  assert.equal(check(checks, "COALITION_KEY").status, "skip");
});

test("a wrong COALITION_URL reads as a wrong URL, not as a rejected key", async () => {
  const { checks, findings } = await probeHub(
    INPUT,
    fakeHttp({ [`POST ${COALITION}/checkout`]: { status: 404 } })
  );
  assert.deepEqual(findings, []);
  assert.match(check(checks, "COALITION_KEY").detail, /COALITION_URL/);
});

test("a trailing slash on either URL does not produce a doubled path", async () => {
  const { findings } = await probeHub(
    { ...INPUT, mtBaseUrl: `${MT}/`, coalitionUrl: `${COALITION}/` },
    fakeHttp()
  );
  assert.deepEqual(findings, []); // fakeHttp throws on any unexpected path
});
