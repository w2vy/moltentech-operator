import type { Finding } from "./config-lint";
import type { ProbeResult } from "./proxmox-probe";

/**
 * Hub probe — proves the three issued keys are still the keys the other side holds.
 *
 * ## The gap this closes, found the hard way (2026-08-23)
 *
 * `mt-manifest init --force` rewrote a live `secrets.env`, and a Flux Hub admin re-issued
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
  agentKey?: string;
  coalitionKey?: string;
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

  // ── 1. AGENT_KEY, against Flux Hub ────────────────────────────────────────────────
  //
  // `GET /api/agent/state` is the same endpoint the running agent polls, so a 200 here
  // is the agent's own credential exercised end to end rather than a proxy for it.
  if (!input.agentKey) {
    checks.push({
      name: "AGENT_KEY → Flux Hub",
      status: "skip",
      detail: "not in secrets.env — /onboard issues it after you paste manifest.json.",
    });
  } else {
    const url = `${base(input.mtBaseUrl)}/api/agent/state`;
    try {
      const res = await http({
        method: "GET",
        url,
        headers: { Authorization: `Bearer ${input.agentKey}` },
      });
      if (isRejection(res.status)) {
        checks.push({ name: "AGENT_KEY → Flux Hub", status: "fail", detail: `rejected (401) by ${url}` });
        findings.push({
          rule: "AGENT_KEY_REJECTED",
          severity: "error",
          file: "secrets.env",
          summary:
            "Flux Hub rejects AGENT_KEY — the agent cannot report or take work. Paste the " +
            "re-issued keys into secrets.env, then `docker compose up -d --force-recreate`",
          message:
            `Flux Hub returned 401 for AGENT_KEY at ${url}. The key in secrets.env is not the one ` +
            "Flux Hub holds — most often because the keys were re-issued (admin → Providers → " +
            "Rotate keys) after this file was written. Nothing else shows this: the stats pull " +
            "Flux Hub uses to set lastSyncedAt is unauthenticated, so the provider page stays green.",
          fix: "copy the re-issued keys into secrets.env, then `docker compose up -d --force-recreate`",
        });
      } else if (res.status === 200) {
        checks.push({
          name: "AGENT_KEY → Flux Hub",
          status: "pass",
          detail: `accepted (200) — ${describeState(res.text)}`,
        });
      } else {
        // Accepted, but something else went wrong. Not a key problem; say so plainly
        // rather than making the operator suspect the credential.
        checks.push({
          name: "AGENT_KEY → Flux Hub",
          status: "skip",
          detail: `${url} answered ${res.status} — the key was NOT rejected; key validity is unproven.`,
        });
      }
    } catch (err) {
      checks.push({
        name: "AGENT_KEY → Flux Hub",
        status: "skip",
        detail: `could not reach ${url} (${(err as Error).message}) — key validity is unproven.`,
      });
    }
  }

  // ── 2. COALITION_KEY, against the DEPLOYED Coalition ──────────────────────────────
  //
  // The one drift that really happens. `secrets.env` is what you would paste into a NEW
  // deploy; the running Flux app holds whatever was imported when it was deployed, and
  // nothing keeps those two in step.
  if (!input.coalitionUrl) {
    checks.push({
      name: "COALITION_KEY → deployed Coalition",
      status: "skip",
      detail: "no COALITION_URL in config.env.",
    });
  } else if (!input.coalitionKey) {
    checks.push({
      name: "COALITION_KEY → deployed Coalition",
      status: "skip",
      detail: "not in secrets.env — /onboard issues it after you paste manifest.json.",
    });
  } else {
    const url = `${base(input.coalitionUrl)}/checkout`;
    try {
      const res = await http({
        method: "POST",
        url,
        headers: {
          Authorization: `Bearer ${input.coalitionKey}`,
          "Content-Type": "application/json",
        },
        // Deliberately invalid: auth runs first, so this separates "key rejected" from
        // "key accepted" without creating anything.
        body: "{}",
      });
      if (!isCoalitionResponse(res)) {
        // Not the Coalition talking — most often Flux's own 503 for an app that is not
        // deployed. Judging the status here would be judging the edge, not the key.
        checks.push({
          name: "COALITION_KEY → deployed Coalition",
          status: "skip",
          detail:
            `${url} answered ${res.status}, but nothing there identifies itself as a Coalition ` +
            `(no x-coalition-version). The Flux app is not deployed or not running, or ` +
            `COALITION_URL points elsewhere — key validity is unproven.`,
        });
      } else if (isRejection(res.status)) {
        checks.push({ name: "COALITION_KEY → deployed Coalition", status: "fail", detail: `rejected (401) by ${url}` });
        findings.push({
          rule: "COALITION_KEY_STALE_DEPLOY",
          severity: "error",
          file: "secrets.env",
          summary:
            "the deployed Coalition rejects COALITION_KEY — customer checkout will fail. " +
            "Re-run `mt-manifest env` and re-import env.json on the Flux app",
          message:
            `${url} returned 401 for the COALITION_KEY in secrets.env. The Flux app is running an ` +
            "environment imported at deploy time; your keys have changed since. Flux Hub relays " +
            "every checkout to that app with the key IT holds, so the first symptom otherwise is a " +
            "customer's purchase failing. Rebuild env.json and re-import it on Flux.",
          fix: "`mt-manifest env`, then re-import env.json on the Flux app and redeploy",
        });
      } else if (res.status === 404) {
        checks.push({
          name: "COALITION_KEY → deployed Coalition",
          status: "skip",
          detail: `${url} answered 404 — no /checkout route there. Is COALITION_URL right?`,
        });
      } else {
        // 400 "Invalid checkout request" is the expected pass: auth succeeded and the
        // empty body was rejected afterwards. 503 (payments disabled) also means auth
        // succeeded, and is the normal answer for a Supporter who sells nothing.
        checks.push({
          name: "COALITION_KEY → deployed Coalition",
          status: "pass",
          detail: `accepted — ${res.status} past the auth check, nothing created.`,
        });
      }
    } catch (err) {
      checks.push({
        name: "COALITION_KEY → deployed Coalition",
        status: "skip",
        detail: `could not reach ${url} (${(err as Error).message}) — key validity is unproven.`,
      });
    }
  }

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
        "`mt-manifest env` and re-import env.json on the Flux app",
      message:
        "The manifest at your Coalition's /.well-known/mt-provider.json carries a pubkey that is " +
        `not the one in manifest-pubkey.txt (served ${short(served.pubkey)}, local ` +
        `${short(localPubkey)}). Flux Hub pins your pubkey at first ingest, so the deployed app is ` +
        "presenting an identity Flux Hub will not accept as yours.",
      fix: "`mt-manifest env`, then re-import env.json on the Flux app and redeploy",
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
        "`mt-manifest env` and re-import env.json on the Flux app",
      message:
        "Your Coalition serves a manifest with a different signature than local manifest.json — " +
        "same key, so this is a re-sign that was never redeployed. Whatever you changed in " +
        "config.env (tiers, prices, listing text) is not what customers see.",
      fix: "`mt-manifest env`, then re-import env.json on the Flux app and redeploy",
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
