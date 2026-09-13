import { randomBytes } from "node:crypto";
import type { Finding } from "./config-lint";
import type { ProbeResult } from "./proxmox-probe";
import {
  HEADER_AGENT_SIGNATURE,
  HEADER_AGENT_TIMESTAMP,
  HEADER_AGENT_NONCE,
  HEADER_AGENT_SLUG,
} from "./common";
import { bodyHash, importPrivateKeyPem, signRequest, type RequestEnvelope } from "./signing";

/**
 * Hub probe — proves the three issued keys are still the keys the other side holds.
 *
 * ## The gap this closes, found the hard way (2026-08-23)
 *
 * `fh-toolkit init --force` rewrote a live `secrets.env`, and a Flux Hub admin re-issued
 * all three keys to recover. Every signal an operator can see stayed green throughout:
 * `doctor` reported `0 error(s)`, the Coalition served the right manifest, and FH's
 * `lastSyncedAt` kept ticking.
 *
 * **None of those touch a key.** FH's stats pull is an UNAUTHENTICATED GET — it reads
 * `/stats` and the `x-coalition-version` header and presents no `coalitionKey` — so a
 * Coalition deployed BEFORE a rotation looks perfectly healthy while holding a dead
 * credential. The first symptom is a customer's checkout failing.
 *
 * The sequencing is what makes this a standing trap rather than a one-off: keys are
 * issued at `/onboard`, the Coalition is deployed some steps LATER, and nothing forces
 * the two to happen in that order ever again. Any rotation between them leaves a running
 * app with stale credentials and no visible symptom until money is involved.
 *
 * ## What is provable from the operator's box, and what is not
 *
 * ✅ `AGENT_KEY` is accepted by FH — a real authenticated call, not a liveness ping.
 * ✅ The DEPLOYED Coalition accepts the `COALITION_KEY` in `secrets.env` — this is the
 *    drift that actually happens, because the deployed copy is a separate artifact.
 * ✅ The deployed manifest is the one you signed (pubkey + signature, byte-compared).
 * ❌ That FH's STORED `coalitionKey` matches. FH keeps it encrypted and only ever uses it
 *    outbound; there is no endpoint that reflects it. Local == FH holds by construction
 *    (you paste what `/onboard` issues), so the drift worth checking is deployed-vs-local.
 *
 * ## Why an invalid body is the right probe
 *
 * `POST /checkout` authenticates BEFORE it parses (`coalition/src/server.ts:128`), so an
 * empty object separates the two answers cleanly: **401 means the key was rejected**, and
 * any other status means auth passed and the request died later on its contents. Nothing
 * is created, no Stripe call is made, no customer is touched.
 *
 * Measured on prod against `moltentech-test1`: agent **200**, coalition **400** with the
 * real key and **401** with a deliberately wrong one. The wrong-key control is what makes
 * the 400 evidence rather than a guess.
 *
 * Everything here is READ-ONLY in effect and opt-in behind `doctor --check-hub`, the same
 * line `--check-stripe` and `--check-proxmox` draw: plain `doctor` holds no credential and
 * reaches no network.
 */

/** One HTTP round trip, injected so the judgement below can be tested without a network. */
export type HubHttp = (req: {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; text: string; headers: Record<string, string> }>;

export interface HubProbeInput {
  /** `MT_BASE_URL` from config.env — where `AGENT_KEY` is proven. */
  mtBaseUrl: string;
  /** `COALITION_URL` from config.env — the DEPLOYED app, not this directory. */
  coalitionUrl?: string;
  /**
   * `MANIFEST_KEY` from secrets.env — base64 of the PKCS#8 PEM. Phase E step 4 removed the
   * `AGENT_KEY`/`COALITION_KEY` bearers, so this is the credential the agent actually uses
   * and therefore the only one worth proving.
   */
  manifestKey?: string;
  /** `PROVIDER_SLUG` — bound into the signed envelope, so it must match what MT expects. */
  providerSlug?: string;
  /** Contents of `manifest-pubkey.txt`, to compare against what the Coalition serves. */
  localPubkey?: string;
  /** Contents of `manifest.json`, to prove the deployed manifest is the signed one. */
  localManifestJson?: string;
}

export interface HubProbeOutput {
  checks: ProbeResult[];
  findings: Finding[];
}

const TIMEOUT_MS = 15_000;

/** Real transport. Never throws for an HTTP status — only for a transport failure. */
export const defaultHubHttp: HubHttp = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: res.status, text: await res.text().catch(() => ""), headers };
};

/** Trim a trailing slash so `${base}/path` never doubles up. */
function base(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Does this status mean the credential was REJECTED?
 *
 * Only 401. A 403 means the key was accepted and the caller lacks something else, and a
 * 400 means it was accepted and the body was wrong — reporting either as a bad key sends
 * the operator to rotate a credential that works. The same distinction `--check-stripe`
 * learned the hard way with restricted keys and `/v1/account`.
 */
function isRejection(status: number): boolean {
  return status === 401;
}

/**
 * Is the thing that answered actually the Coalition?
 *
 * Every Coalition response carries `X-Coalition-Version` — set on the raw response before
 * any routing (`coalition/src/server.ts:54`), so it is present on 401, 400 and 503 alike.
 * Flux's edge serves its OWN html 503 page (`Error 503 FDM-…`) for an app that is not
 * deployed or not running, and that page has no such header.
 *
 * Without this test that page reads as a PASS: 503 sits on the accept side of the
 * 401/not-401 split, so a Coalition that was never deployed reported its key as ACCEPTED
 * (measured 2026-08-24 against an undeployed app). That is the worst direction for this
 * check to fail — a stale key is exactly what it exists to catch before a customer does.
 * Anything that does not identify itself as a Coalition proves nothing about the key.
 */
function isCoalitionResponse(res: { headers: Record<string, string> }): boolean {
  return typeof res.headers["x-coalition-version"] === "string";
}

export async function probeHub(
  input: HubProbeInput,
  http: HubHttp = defaultHubHttp
): Promise<HubProbeOutput> {
  const checks: ProbeResult[] = [];
  const findings: Finding[] = [];

  // ── 1. MANIFEST_KEY, against Flux Hub ─────────────────────────────────────────────
  //
  // `GET /api/agent/state` is the same endpoint the running agent polls, signed the same
  // way the agent signs it, so a 200 here is the agent's own credential exercised end to
  // end rather than a proxy for it.
  //
  // This checked the `AGENT_KEY` bearer until Phase E step 4 (2026-09-07). Flux Hub no
  // longer accepts bearers at all, so that check could only ever have returned 401 — a
  // healthy hub reported as rejecting a valid operator. Signing is not a nicety here; it
  // is the difference between a useful check and a false alarm.
  const NAME_HUB = "MANIFEST_KEY → Flux Hub";
  if (!input.manifestKey || !input.providerSlug) {
    checks.push({
      name: NAME_HUB,
      status: "skip",
      detail: !input.manifestKey
        ? "no MANIFEST_KEY in secrets.env — `fh-toolkit init` writes it from manifest-key.pem."
        : "no PROVIDER_SLUG in config.env — the slug is bound into the signature.",
    });
  } else {
    const url = `${base(input.mtBaseUrl)}/api/agent/state`;
    try {
      const key = importPrivateKeyPem(Buffer.from(input.manifestKey, "base64").toString("utf8"));
      const env: RequestEnvelope = {
        method: "GET",
        path: "/api/agent/state",
        slug: input.providerSlug,
        issuedAt: new Date().toISOString(),
        nonce: randomBytes(16).toString("hex"),
        bodyHash: bodyHash(""),
      };
      const res = await http({
        method: "GET",
        url,
        headers: {
          [HEADER_AGENT_SIGNATURE]: signRequest(env, key),
          [HEADER_AGENT_TIMESTAMP]: env.issuedAt,
          [HEADER_AGENT_NONCE]: env.nonce,
          [HEADER_AGENT_SLUG]: input.providerSlug,
        },
      });
      if (isRejection(res.status)) {
        checks.push({ name: NAME_HUB, status: "fail", detail: `rejected (401) by ${url}` });
        findings.push({
          rule: "MANIFEST_KEY_REJECTED",
          severity: "error",
          file: "secrets.env",
          summary:
            "Flux Hub rejects your signature — the agent cannot report or take work. Re-run " +
            "`fh-toolkit keygen`, re-ingest the manifest, then `fh-agent restart` (docker compose up -d --force-recreate)",
          message:
            `Flux Hub returned 401 for a MANIFEST_KEY signature at ${url}. Either the key in ` +
            "secrets.env is not the private half of the pubkey Flux Hub pinned as " +
            "`Provider.manifestPubkey`, or the manifest was never re-ingested after a keygen. " +
            "Nothing else shows this: the stats pull Flux Hub uses to set lastSyncedAt is " +
            "unauthenticated, so the provider page stays green.",
          fix: "re-ingest manifest.json at /onboard, then `fh-agent restart` (docker compose up -d --force-recreate)",
        });
      } else if (res.status === 200) {
        checks.push({
          name: NAME_HUB,
          status: "pass",
          detail: `accepted (200) — ${describeState(res.text)}`,
        });
      } else {
        // Accepted, but something else went wrong. Not a key problem; say so plainly
        // rather than making the operator suspect the credential.
        checks.push({
          name: NAME_HUB,
          status: "skip",
          detail: `${url} answered ${res.status} — the key was NOT rejected; key validity is unproven.`,
        });
      }
    } catch (err) {
      checks.push({
        name: NAME_HUB,
        status: "skip",
        detail: `could not sign or reach ${url} (${(err as Error).message}) — key validity is unproven.`,
      });
    }
  }

  // ── 2. The deployed Coalition's inbound auth — NOT CHECKABLE FROM HERE ────────────
  //
  // This used to POST `/checkout` with the `COALITION_KEY` bearer, which caught the one
  // drift that really happens: `secrets.env` holds what you would paste into a NEW deploy,
  // the running Flux app holds whatever was imported when it was deployed, and nothing
  // keeps those in step.
  //
  // Phase E step 4 (2026-09-07) removed that bearer. Inbound `/checkout` and `/manage` now
  // accept exactly one thing: a request signed by FLUX HUB's key — which the operator does
  // not hold and must never hold. So this is not a check that regressed; it is one that
  // stopped being the operator's to run.
  //
  // What still covers the same ground: check 3 proves the DEPLOYED Coalition is answering
  // and which manifest it is serving, and a signed call that Flux Hub itself makes shows up
  // as `authorized via=signature` in the Coalition's own log.
  checks.push({
    name: "Coalition inbound auth",
    status: "skip",
    detail:
      "not checkable by the operator — /checkout accepts only a Flux Hub signature since " +
      "Phase E. Reachability and manifest freshness are covered below.",
  });

  // ── 3. The deployed manifest is the one you signed ────────────────────────────────
  //
  // Free alongside the key checks, and the same class of defect: what the Coalition
  // SERVES is a copy taken at deploy time, so an edit-and-re-sign that was never
  // re-imported is invisible from here in exactly the same way a stale key is.
  if (input.coalitionUrl) {
    const url = `${base(input.coalitionUrl)}/.well-known/mt-provider.json`;
    try {
      const res = await http({ method: "GET", url, headers: {} });
      if (res.status !== 200) {
        checks.push({
          name: "deployed manifest",
          status: "skip",
          detail: `${url} answered ${res.status}.`,
        });
      } else {
        checks.push(...judgeDeployedManifest(res.text, input, findings));
      }
    } catch (err) {
      checks.push({
        name: "deployed manifest",
        status: "skip",
        detail: `could not reach ${url} (${(err as Error).message}).`,
      });
    }
  }

  // ── 4. Which build is actually running ────────────────────────────────────────────
  //
  // Informational, and cheap: the same version string Flux Hub reads from the
  // `x-coalition-version` header on its stats pull, so an operator can tell whether a
  // republished image was ever redeployed.
  if (input.coalitionUrl) {
    const url = `${base(input.coalitionUrl)}/health`;
    try {
      const res = await http({ method: "GET", url, headers: {} });
      const version =
        res.headers["x-coalition-version"] ?? safeJson(res.text)?.coalitionVersion ?? "unknown";
      checks.push({
        name: "deployed Coalition build",
        status: res.status === 200 ? "pass" : "skip",
        detail: res.status === 200 ? `version ${version}` : `${url} answered ${res.status}.`,
      });
    } catch {
      // Already reported by the checks above; a second unreachable line adds nothing.
    }
  }

  return { checks, findings };
}

/** Compare what the Coalition serves against what was signed here. Pushes findings. */
function judgeDeployedManifest(
  servedText: string,
  input: HubProbeInput,
  findings: Finding[]
): ProbeResult[] {
  const served = safeJson(servedText);
  if (!served) {
    return [{ name: "deployed manifest", status: "skip", detail: "served body is not JSON." }];
  }
  const localPubkey = input.localPubkey?.trim();
  const local = input.localManifestJson ? safeJson(input.localManifestJson) : undefined;

  // The pubkey is the provider's identity, pinned by Flux Hub at first ingest. A mismatch
  // means the deployed app is signing as somebody else — including a past self, if a key
  // was ever rotated.
  if (localPubkey && served.pubkey && served.pubkey !== localPubkey) {
    findings.push({
      rule: "COALITION_MANIFEST_WRONG_PUBKEY",
      severity: "error",
      file: "manifest.json",
      summary:
        "the deployed Coalition serves a manifest signed by a DIFFERENT key — re-run " +
        "`fh-toolkit env` and re-import env.json on the Flux app",
      message:
        "The manifest at your Coalition's /.well-known/mt-provider.json carries a pubkey that is " +
        `not the one in manifest-pubkey.txt (served ${short(served.pubkey)}, local ` +
        `${short(localPubkey)}). Flux Hub pins your pubkey at first ingest, so the deployed app is ` +
        "presenting an identity Flux Hub will not accept as yours.",
      fix: "`fh-toolkit env`, then re-import env.json on the Flux app and redeploy",
    });
    return [{ name: "deployed manifest", status: "fail", detail: "signed by a different key" }];
  }

  // Same pubkey, different bytes: an edit was signed here and never redeployed. Warning,
  // not error — nothing is broken, but the listing Flux Hub reads is out of date.
  if (local?.signature && served.signature && local.signature !== served.signature) {
    findings.push({
      rule: "COALITION_MANIFEST_STALE_DEPLOY",
      severity: "warning",
      file: "manifest.json",
      summary:
        "the deployed Coalition serves an OLDER manifest than the one signed here — re-run " +
        "`fh-toolkit env` and re-import env.json on the Flux app",
      message:
        "Your Coalition serves a manifest with a different signature than local manifest.json — " +
        "same key, so this is a re-sign that was never redeployed. Whatever you changed in " +
        "config.env (tiers, prices, listing text) is not what customers see.",
      fix: "`fh-toolkit env`, then re-import env.json on the Flux app and redeploy",
    });
    return [{ name: "deployed manifest", status: "fail", detail: "older than local manifest.json" }];
  }

  return [
    {
      name: "deployed manifest",
      status: "pass",
      detail: localPubkey || local ? "matches the one signed here" : "served (nothing local to compare)",
    },
  ];
}

/** Turn FH's agent-state body into one human line, without depending on its shape. */
function describeState(text: string): string {
  const json = safeJson(text);
  const slots = Array.isArray(json?.slots) ? json.slots : undefined;
  if (!slots) return "Flux Hub answered with your provider state";
  const names = slots.map((s: any) => s?.vmName).filter(Boolean);
  return `Flux Hub sees ${slots.length} slot(s)${names.length ? `: ${names.join(", ")}` : ""}`;
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Keys are long; show head and tail, because a paste error shows at the TAIL. */
function short(key: string): string {
  return key.length <= 20 ? key : `${key.slice(0, 8)}…${key.slice(-6)}`;
}
