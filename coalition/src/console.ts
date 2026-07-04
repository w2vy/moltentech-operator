/**
 * Operator console + owner-authorization courier (WS3, "courier-coalition").
 *
 * The coalition holds NO keys. It is a UI + a signature courier:
 *   - agent ⇒ POST /agent/pending          push the pending-authorization list
 *   - operator (browser) ⇒ GET /console     see pending + sign each in their wallet
 *   - operator (browser) ⇒ POST /console/authorize   submit the wallet signature
 *   - agent ⇐ GET /agent/authorizations     pull the operator-signed blobs
 * The agent stays outbound-only (it polls here); it relays the signed blobs to MT.
 *
 * Trust: agent⇄coalition is authenticated with the manifest keypair (the agent
 * signs, we verify against the manifest pubkey we already serve). Browser submits
 * are per-action wallet-signed — we verify each signature recovers to the operator's
 * owner ZelID before queuing it. The agent re-verifies authoritatively on pickup.
 *
 * CV6 read-gate: since the coalition is a public Flux App, a wallet LOGIN (challenge
 * → sign → HMAC session cookie, see `session.ts`) gates VIEWING the console when
 * SESSION_SECRET is set. It is a read/convenience gate ONLY — actions are still
 * per-action signed, so a stolen cookie can read state but cannot authorize anything.
 */
import type { IncomingHttpHeaders } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  PendingAuthPush,
  type PendingAuthItem,
  type SignedAuthorization,
  NodeStateList,
  type NodeStateItem,
  OwnerAuth,
  type OwnerAuthClaim,
  ownerAuthMessage,
  HEADER_AGENT_SIGNATURE,
  HEADER_AGENT_TIMESTAMP,
  HEADER_AGENT_NONCE,
  HEADER_AGENT_SLUG,
} from "@moltentech/protocol";
import { bodyHash, checkFreshness, verifyRequest, type RequestEnvelope } from "@moltentech/protocol/signing";
import { verifyFluxSignature } from "@moltentech/protocol/wallet";
import {
  buildOwnerAuthSignLauncher,
  buildSignLauncherHtml,
  buildZelcoreSignLink,
  escapeHtmlAttribute,
  CONSOLE_THEME_CSS,
} from "@moltentech/protocol/sign-launcher";
import { mintSessionCookie, newNonce } from "./session";
import type { CoalitionConfig } from "./config";

export type ConsoleResult = { status: number; contentType: string; body: string; headers?: Record<string, string> };
const json = (status: number, obj: unknown): ConsoleResult => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(obj),
});
const html = (status: number, body: string): ConsoleResult => ({ status, contentType: "text/html; charset=utf-8", body });

// ── In-memory courier state (single-use + short-lived; a restart just means re-sign) ──
const pending = new Map<string, PendingAuthItem>(); // slotId -> item awaiting signature
const authorizations: SignedAuthorization[] = []; // signed, awaiting agent pickup
let nodeState: NodeStateItem[] = []; // latest dashboard snapshot the agent pushed

// Nonces of claims we've queued, so the sign page can poll for success even after
// the item leaves `pending` (or the agent re-pushes the still-pending slot before
// its relay lands). Keyed on the claim NONCE — the stable per-signature signal.
const AUTH_NONCE_TTL_MS = 20 * 60_000;
const authorizedNonces = new Map<string, number>(); // nonce -> expiry (ms epoch)
function markAuthorized(nonce: string): void {
  const now = Date.now();
  for (const [n, exp] of authorizedNonces) if (exp <= now) authorizedNonces.delete(n);
  authorizedNonces.set(nonce, now + AUTH_NONCE_TTL_MS);
}
function isAuthorized(nonce: string): boolean {
  const exp = authorizedNonces.get(nonce);
  if (exp == null) return false;
  if (exp <= Date.now()) {
    authorizedNonces.delete(nonce);
    return false;
  }
  return true;
}

// CV6 login challenges: id -> the exact message to sign + expiry (+ authedAddr once
// a Zelcore callback satisfies it, so the browser poll can mint the cookie).
const CHALLENGE_TTL_MS = 10 * 60_000;
type Challenge = { message: string; exp: number; authedAddr?: string };
const challenges = new Map<string, Challenge>();
function getChallenge(id: string): Challenge | null {
  const c = challenges.get(id);
  if (!c) return null;
  if (c.exp <= Date.now()) {
    challenges.delete(id);
    return null;
  }
  return c;
}
/** The human-readable console-login message the owner signs (bound to a fresh nonce). */
function loginMessage(slug: string, nonce: string, issuedAt: string): string {
  return ["MoltenTech operator console login", `provider: ${slug}`, `nonce: ${nonce}`, `issued: ${issuedAt}`].join("\n");
}

// ── manifest-derived values (pubkey for agent auth; coalitionUrl for the Zelcore callback base) ──
let cachedManifest: { pubkey?: string; coalitionUrl?: string } | null = null;
function manifest(cfg: CoalitionConfig): { pubkey?: string; coalitionUrl?: string } {
  if (cachedManifest) return cachedManifest;
  try {
    cachedManifest = JSON.parse(readFileSync(cfg.manifestPath, "utf8"));
  } catch {
    cachedManifest = {};
  }
  return cachedManifest!;
}
function manifestPubkey(cfg: CoalitionConfig): string | null {
  return manifest(cfg).pubkey ?? null;
}

const NONCE_TTL_MS = 5 * 60_000;
const seenNonces = new Map<string, number>();
function rememberNonce(nonce: string): boolean {
  const now = Date.now();
  for (const [n, exp] of seenNonces) if (exp <= now) seenNonces.delete(n);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now + NONCE_TTL_MS);
  return true;
}

/** True iff the request carries a valid agent (manifest-key) signature. */
function verifyAgentRequest(
  cfg: CoalitionConfig,
  method: string,
  path: string,
  rawBody: Buffer,
  headers: IncomingHttpHeaders
): boolean {
  const pubkey = manifestPubkey(cfg);
  const signature = headers[HEADER_AGENT_SIGNATURE];
  const issuedAt = headers[HEADER_AGENT_TIMESTAMP];
  const nonce = headers[HEADER_AGENT_NONCE];
  const slug = headers[HEADER_AGENT_SLUG];
  if (!pubkey || typeof signature !== "string" || typeof issuedAt !== "string" || typeof nonce !== "string" || typeof slug !== "string") {
    return false;
  }
  if (slug !== cfg.providerSlug || !checkFreshness(issuedAt)) return false;
  const env: RequestEnvelope = { method, path, slug: cfg.providerSlug, issuedAt, nonce, bodyHash: bodyHash(rawBody) };
  if (!verifyRequest(env, signature, pubkey)) return false;
  if (!rememberNonce(nonce)) return false; // burn only after a valid sig
  return true;
}

// ── Owner ZelID the console authorizes against (env var; Flux app-owner lookup is a future add) ──
function ownerZelid(cfg: CoalitionConfig): string | undefined {
  return cfg.ownerAddress;
}

const encodeClaim = (c: OwnerAuthClaim): string => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
function decodeClaim(token: string): OwnerAuthClaim | null {
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as OwnerAuthClaim;
  } catch {
    return null;
  }
}

// ── agent-facing handlers ──
/** POST /agent/pending — replace the pending list the console presents. */
export function handleAgentPending(cfg: CoalitionConfig, rawBody: Buffer, headers: IncomingHttpHeaders): ConsoleResult {
  if (!verifyAgentRequest(cfg, "POST", "/agent/pending", rawBody, headers)) return json(401, { error: "Unauthorized" });
  const parsed = PendingAuthPush.safeParse(JSON.parse(rawBody.toString() || "{}"));
  if (!parsed.success) return json(400, { error: "Invalid pending payload" });
  pending.clear();
  for (const item of parsed.data.items) {
    if (item.providerSlug === cfg.providerSlug) pending.set(item.slotId, item);
  }
  return json(200, { ok: true, pending: pending.size });
}

/** POST /agent/state — replace the dashboard's slot-state snapshot. */
export function handleAgentState(cfg: CoalitionConfig, rawBody: Buffer, headers: IncomingHttpHeaders): ConsoleResult {
  if (!verifyAgentRequest(cfg, "POST", "/agent/state", rawBody, headers)) return json(401, { error: "Unauthorized" });
  const parsed = NodeStateList.safeParse(JSON.parse(rawBody.toString() || "{}"));
  if (!parsed.success) return json(400, { error: "Invalid state payload" });
  nodeState = parsed.data.items;
  return json(200, { ok: true, nodes: nodeState.length });
}

/** GET /agent/authorizations — hand the queued signed blobs to the agent and clear them. */
export function handleAgentAuthorizations(cfg: CoalitionConfig, rawBody: Buffer, headers: IncomingHttpHeaders): ConsoleResult {
  if (!verifyAgentRequest(cfg, "GET", "/agent/authorizations", rawBody, headers)) return json(401, { error: "Unauthorized" });
  const items = authorizations.splice(0, authorizations.length);
  return json(200, { items });
}

// ── operator (browser) handlers ──
/** Action → coloured pill (delete=red, reprovision=amber, move=cyan). */
function actionBadge(action: string): string {
  const cls = action === "delete" ? "badge-delete" : action === "reprovision" ? "badge-reprovision" : "badge-move";
  return `<span class="badge ${cls}">${escapeHtmlAttribute(action)}</span>`;
}

/** Slot status → coloured pill. */
function statusBadge(status: string): string {
  const s = status.toLowerCase();
  const cls = ["active", "bootstrap", "benchmark", "awaiting_start"].includes(s)
    ? "badge-ok"
    : s === "available"
      ? "badge-info"
      : ["provisioning", "pending_config", "maintenance"].includes(s)
        ? "badge-warn"
        : ["pending_delete", "deleting"].includes(s)
          ? "badge-bad"
          : "badge-mut";
  return `<span class="badge ${cls}">${escapeHtmlAttribute(status)}</span>`;
}

/** GET /console — operator dashboard: node/rental state + actions awaiting signature. */
export function handleConsoleIndex(cfg: CoalitionConfig): ConsoleResult {
  const slug = escapeHtmlAttribute(cfg.providerSlug);

  // Section 1 — node/rental state (from the agent's pushed snapshot).
  const stateRows = nodeState.length
    ? nodeState
        .map((n) => {
          const rental = n.rentalCode ? `<code>${escapeHtmlAttribute(n.rentalCode)}</code>` : `<span class="muted">—</span>`;
          return `<tr><td class="mono">${escapeHtmlAttribute(n.nodeName)}</td><td class="mono">${escapeHtmlAttribute(n.vmName)}</td><td>${escapeHtmlAttribute(n.tier)}</td><td>${statusBadge(n.status)}</td><td>${rental}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="muted">No node state yet — the agent pushes a snapshot each heartbeat.</td></tr>`;

  // Section 2 — pending privileged actions.
  const actions = [...pending.values()];
  const actionRows = actions.length
    ? actions
        .map((it) => {
          const vm = escapeHtmlAttribute(`${it.vmName}@${it.nodeName}`);
          const code = it.rentalCode ? `<code>${escapeHtmlAttribute(it.rentalCode)}</code>` : `<span class="muted">—</span>`;
          return `<tr><td>${actionBadge(it.action)} <span class="mono">${vm}</span></td><td>${code}</td><td><a class="btn btn-primary" href="/console/sign?slotId=${encodeURIComponent(it.slotId)}">Review &amp; sign</a></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="3" class="muted">No actions awaiting your signature.</td></tr>`;

  const count = actions.length ? ` <span class="badge badge-warn">${actions.length}</span>` : "";
  return html(
    200,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta http-equiv="refresh" content="15"/>
<title>MoltenTech Operator Console — ${slug}</title>
<style>${CONSOLE_THEME_CSS}</style></head><body>
<div class="wrap">
<header class="mt"><span class="mark">MoltenTech</span><span class="slug">operator console · ${slug}</span></header>
<h1>Nodes</h1>
<p class="muted">Your slots and their live state. Refreshes every 15s.</p>
<div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto">
<table><thead><tr><th>Node</th><th>VM</th><th>Tier</th><th>Status</th><th>Rental</th></tr></thead><tbody>${stateRows}</tbody></table>
</div></div>
<h1 style="margin-top:26px">Actions awaiting your signature${count}</h1>
<p class="muted">Each privileged action is authorized by signing it in your Flux owner wallet.</p>
<div class="card" style="padding:0;overflow:hidden"><div style="overflow-x:auto">
<table><thead><tr><th>Action</th><th>Rental</th><th></th></tr></thead><tbody>${actionRows}</tbody></table>
</div></div>
</div>
</body></html>`
  );
}

/** GET /console/sign?slotId=… — build the claim + render the WS1 launcher + a submit form. */
export function handleConsoleSign(cfg: CoalitionConfig, query: URLSearchParams, origin?: string): ConsoleResult {
  const slotId = query.get("slotId") ?? "";
  const item = pending.get(slotId);
  if (!item) return html(404, "<p>Unknown or already-processed action.</p>");

  const claim: OwnerAuthClaim = {
    action: item.action,
    providerSlug: item.providerSlug,
    vmName: item.vmName,
    nodeName: item.nodeName,
    nonce: randomBytes(16).toString("hex"),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
  const claimToken = encodeClaim(claim);
  // Give Zelcore a callback so it posts the signature straight back — no copy-paste.
  // Prefer the request's own origin (works wherever the console is served — Flux
  // ingress, Caddy, etc.); fall back to the manifest coalitionUrl.
  const base = (origin ?? manifest(cfg).coalitionUrl)?.replace(/\/$/, "");
  const callback = base
    ? `${base}/console/zelcore-callback?slotId=${encodeURIComponent(slotId)}&claim=${encodeURIComponent(claimToken)}`
    : undefined;
  const { html: launcher } = buildOwnerAuthSignLauncher(claim, { callback });

  // Inject a submit form before </body>: it carries the exact claim + the signature
  // (auto-filled from the SSP result box, or pasted for Zelcore) back to us.
  const submit = `
    <div class="wrap">
      <div class="card done" id="done-panel">
        <div class="big">✓</div>
        <h2>Authorized</h2>
        <p class="muted">Your agent will execute this shortly. You can close this tab.</p>
        <p><a href="/console">&larr; Back to console</a></p>
      </div>
      <div class="card" id="expiry-card">
        <span class="muted">Sign with a wallet above — SSP submits itself, and Zelcore posts back automatically. This request expires in <span class="mono" id="countdown">—</span>.</span>
      </div>
      <details class="card" id="manual-paste">
        <summary>Signature didn't post back? Paste it manually</summary>
        <form id="submit-form" style="margin-top:10px">
          <input type="hidden" name="slotId" value="${escapeHtmlAttribute(slotId)}" />
          <input type="hidden" name="claim" value="${escapeHtmlAttribute(claimToken)}" />
          <textarea name="signature" id="submit-sig" class="sig-box" placeholder="Paste the signature from your wallet"></textarea>
          <div><button type="submit" class="btn btn-primary" style="margin-top:8px">Submit authorization</button></div>
          <p class="muted" id="submit-err" style="color:#f87171;display:none;margin-top:8px"></p>
        </form>
      </details>
      <p style="margin-top:4px"><a href="/console">&larr; Back to console</a></p>
    </div>
    <script>
      var claimToken = ${JSON.stringify(claimToken)};
      var expiresAt = ${JSON.stringify(claim.expiresAt)};
      var done = false, pollT = null;

      function showDone(){
        if(done) return; done = true;
        document.querySelectorAll('.wallet-section').forEach(function(el){ el.style.display='none'; });
        ['manual-paste','expiry-card'].forEach(function(id){ var e=document.getElementById(id); if(e) e.style.display='none'; });
        var dp=document.getElementById('done-panel'); if(dp) dp.style.display='block';
        if(pollT){ clearInterval(pollT); pollT=null; }
      }

      // Submit the signature to the server WITHOUT navigating away, so every path
      // (SSP auto, Zelcore callback, manual paste) ends on the same in-page done state.
      async function submitSig(){
        var box=document.getElementById('submit-sig'); var sig=(box.value||'').trim();
        if(!sig) return;
        var err=document.getElementById('submit-err'); if(err) err.style.display='none';
        var body=new URLSearchParams({ slotId:document.querySelector('[name=slotId]').value,
          claim:document.querySelector('[name=claim]').value, signature:sig });
        try{
          var r=await fetch('/console/authorize',{ method:'POST',
            headers:{'content-type':'application/x-www-form-urlencoded'}, body:body.toString() });
          if(r.ok){ showDone(); }
          else if(err){ var t=await r.text(); err.textContent=(t||'Submit failed').replace(/<[^>]*>/g,'').trim(); err.style.display='block'; }
        }catch(e){ if(err){ err.textContent=String(e); err.style.display='block'; } }
      }
      document.getElementById('submit-form').addEventListener('submit', function(e){ e.preventDefault(); submitSig(); });

      // SSP writes its signature into #sig-output → mirror into the box + auto-submit.
      (function(){ var src=document.getElementById('sig-output'), dst=document.getElementById('submit-sig');
        if(!src||!dst) return;
        new MutationObserver(function(){ var v=(src.textContent||'').trim();
          if(v && !dst.value){ dst.value=v; submitSig(); } })
          .observe(src,{childList:true,characterData:true,subtree:true}); })();

      // Poll for the Zelcore-callback path (Zelcore posts the sig server→server, not to this page).
      pollT=setInterval(async function(){
        try{ var r=await fetch('/console/sign-status?claim='+encodeURIComponent(claimToken));
          if(r.ok){ var j=await r.json(); if(j.status==='authorized') showDone(); } }catch(e){}
      }, 3000);

      // Live expiry countdown.
      (function(){ var el=document.getElementById('countdown'); if(!el) return;
        var end=new Date(expiresAt).getTime();
        function tick(){ var s=Math.floor((end-Date.now())/1000);
          if(s<=0){ el.textContent='expired'; return; }
          el.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }
        tick(); setInterval(tick,1000); })();
    </script>`;
  return html(200, launcher.replace("</body>", `${submit}</body>`));
}

/**
 * Shared per-action gate + queue for a submitted signature (used by both the
 * browser form and the Zelcore callback). Verifies the signature recovers to the
 * operator's owner ZelID over the exact claim, that the claim still matches a
 * pending item, then queues the authorization. Login-less: the signature IS the auth.
 */
function verifyAndQueue(
  cfg: CoalitionConfig,
  slotId: string,
  claimToken: string,
  signature: string
): { ok: true; claim: OwnerAuthClaim } | { ok: false; status: number; msg: string } {
  const owner = ownerZelid(cfg);
  if (!owner) return { ok: false, status: 500, msg: "Console owner address not configured (set OWNER_ADDRESS)." };
  const claim = decodeClaim(claimToken);
  if (!claim || !signature) return { ok: false, status: 400, msg: "Missing claim or signature." };

  const item = pending.get(slotId);
  if (!item || item.action !== claim.action || item.vmName !== claim.vmName || item.nodeName !== claim.nodeName || item.providerSlug !== claim.providerSlug) {
    return { ok: false, status: 409, msg: "Action no longer pending, or claim does not match." };
  }
  if (!verifyFluxSignature(owner, ownerAuthMessage(claim), signature)) {
    return { ok: false, status: 401, msg: "Signature does not match the owner wallet for this operator." };
  }
  const authParsed = OwnerAuth.safeParse({ ...claim, signature });
  if (!authParsed.success) return { ok: false, status: 400, msg: "Malformed authorization." };

  authorizations.push({ slotId, ownerAuth: authParsed.data });
  pending.delete(slotId);
  markAuthorized(claim.nonce); // let the sign page's poll report success
  return { ok: true, claim };
}

/** GET /console/sign-status?claim=… — has this exact claim been queued yet? */
export function handleSignStatus(query: URLSearchParams): ConsoleResult {
  const claim = decodeClaim(query.get("claim") ?? "");
  if (!claim) return json(400, { error: "bad claim" });
  return json(200, { status: isAuthorized(claim.nonce) ? "authorized" : "pending" });
}

/** POST /console/authorize — browser form submit (SSP auto-fill or pasted Zelcore sig). */
export function handleConsoleAuthorize(cfg: CoalitionConfig, form: URLSearchParams): ConsoleResult {
  const r = verifyAndQueue(cfg, form.get("slotId") ?? "", form.get("claim") ?? "", (form.get("signature") ?? "").trim());
  const page = (status: number, title: string, bodyHtml: string) =>
    html(
      status,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title><style>${CONSOLE_THEME_CSS}</style></head><body><div class="wrap">
<header class="mt"><span class="mark">MoltenTech</span><span class="slug">operator console</span></header>
${bodyHtml}<p style="margin-top:12px"><a href="/console">&larr; Back to console</a></p></div></body></html>`
    );
  if (!r.ok) return page(r.status, "Not authorized", `<div class="card"><h1>Could not queue</h1><p class="muted">${escapeHtmlAttribute(r.msg)}</p></div>`);
  return page(
    200,
    "Authorized",
    `<div class="card done" style="display:block"><div class="big">✓</div><h1>Authorization queued</h1>
<p class="muted">${actionBadge(r.claim.action)} <span class="mono">${escapeHtmlAttribute(`${r.claim.vmName}@${r.claim.nodeName}`)}</span> will be executed by your agent shortly.</p></div>`
  );
}

/**
 * POST /console/zelcore-callback?slotId=…&claim=… — Zelcore posts the signature
 * here automatically (the `callback` on the sign deep link), so the operator never
 * copy-pastes. Zelcore sends `{ zelid, signature }` (JSON or form); we already hold
 * the message via the claim in the query. Same gate as the browser submit.
 */
export function handleZelcoreCallback(
  cfg: CoalitionConfig,
  query: URLSearchParams,
  rawBody: Buffer,
  contentType: string
): ConsoleResult {
  let signature = "";
  const raw = rawBody.toString();
  try {
    if (contentType.includes("application/json")) {
      signature = String((JSON.parse(raw || "{}") as { signature?: unknown }).signature ?? "");
    } else {
      signature = new URLSearchParams(raw).get("signature") ?? "";
    }
  } catch {
    signature = "";
  }
  const r = verifyAndQueue(cfg, query.get("slotId") ?? "", query.get("claim") ?? "", signature.trim());
  // Zelcore only needs a status; the operator's console page auto-refreshes to reflect it.
  return r.ok ? json(200, { status: "success" }) : json(r.status, { status: "error", error: r.msg });
}

/** Pull a `signature` out of a wallet POST body (JSON or form-encoded). */
function readSignatureFromBody(rawBody: Buffer, contentType: string): string {
  const raw = rawBody.toString();
  try {
    if (contentType.includes("application/json")) {
      return String((JSON.parse(raw || "{}") as { signature?: unknown }).signature ?? "").trim();
    }
    return (new URLSearchParams(raw).get("signature") ?? "").trim();
  } catch {
    return "";
  }
}

// ── CV6 wallet-login (read-gate). Gates ONLY the browser read/submit routes; every
// action is still per-action wallet-signed. Enabled iff SESSION_SECRET is set. ──

/** GET /console/login — challenge page: sign the login message to mint a session. */
export function handleLoginPage(cfg: CoalitionConfig, origin?: string): ConsoleResult {
  const owner = ownerZelid(cfg);
  if (!owner) return html(500, "<p>Console owner address not configured (set OWNER_ADDRESS).</p>");
  const id = newNonce();
  const message = loginMessage(cfg.providerSlug, id, new Date().toISOString());
  challenges.set(id, { message, exp: Date.now() + CHALLENGE_TTL_MS });

  const base = (origin ?? manifest(cfg).coalitionUrl)?.replace(/\/$/, "");
  const callback = base ? `${base}/console/login-callback?challenge=${encodeURIComponent(id)}` : undefined;
  const zelcoreLink = buildZelcoreSignLink({ message, callback });
  const launcher = buildSignLauncherHtml({
    message,
    zelcoreLink,
    title: "Operator console login",
    intro: `Sign in to the ${cfg.providerSlug} console by signing this challenge with your Flux owner wallet. No password — your signature proves ownership.`,
  });

  const submit = `
    <div class="wrap">
      <div class="card done" id="done-panel"><div class="big">✓</div><h2>Signed in</h2>
        <p class="muted">Redirecting to the console…</p></div>
      <details class="card" id="manual-paste">
        <summary>Signature didn't post back? Paste it manually</summary>
        <form id="login-form" style="margin-top:10px">
          <input type="hidden" name="challenge" value="${escapeHtmlAttribute(id)}" />
          <textarea name="signature" id="submit-sig" class="sig-box" placeholder="Paste the signature from your wallet"></textarea>
          <div><button type="submit" class="btn btn-primary" style="margin-top:8px">Sign in</button></div>
          <p class="muted" id="login-err" style="color:#f87171;display:none;margin-top:8px"></p>
        </form>
      </details>
    </div>
    <script>
      var challengeId = ${JSON.stringify(id)};
      var done = false, pollT = null;
      function goConsole(){ if(done) return; done=true; if(pollT){clearInterval(pollT);pollT=null;} location.href='/console'; }
      async function loginSig(){
        var box=document.getElementById('submit-sig'); var sig=(box.value||'').trim(); if(!sig) return;
        var err=document.getElementById('login-err'); if(err) err.style.display='none';
        var body=new URLSearchParams({ challenge:challengeId, signature:sig });
        try{
          var r=await fetch('/console/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString()});
          if(r.ok){ goConsole(); } else if(err){ var t=await r.json().catch(function(){return{};}); err.textContent=(t.error||'Sign-in failed'); err.style.display='block'; }
        }catch(e){ if(err){ err.textContent=String(e); err.style.display='block'; } }
      }
      document.getElementById('login-form').addEventListener('submit', function(e){ e.preventDefault(); loginSig(); });
      // SSP writes its sig into #sig-output → auto-submit.
      (function(){ var src=document.getElementById('sig-output'), dst=document.getElementById('submit-sig');
        if(!src||!dst) return;
        new MutationObserver(function(){ var v=(src.textContent||'').trim(); if(v && !dst.value){ dst.value=v; loginSig(); } })
          .observe(src,{childList:true,characterData:true,subtree:true}); })();
      // Poll for the Zelcore-callback path (the poll response mints the cookie once authenticated).
      pollT=setInterval(async function(){
        try{ var r=await fetch('/console/login-status?challenge='+encodeURIComponent(challengeId));
          if(r.ok){ var j=await r.json(); if(j.status==='authenticated') goConsole(); } }catch(e){}
      }, 3000);
    </script>`;
  return html(200, launcher.replace("</body>", `${submit}</body>`));
}

/** POST /console/login — browser submit (SSP auto / manual paste). Verifies + mints the cookie. */
export function handleLoginSubmit(cfg: CoalitionConfig, params: URLSearchParams): ConsoleResult {
  const secret = cfg.sessionSecret;
  if (!secret) return json(400, { error: "login disabled" });
  const owner = ownerZelid(cfg);
  if (!owner) return json(500, { error: "owner not configured" });
  const c = getChallenge(params.get("challenge") ?? "");
  const signature = (params.get("signature") ?? "").trim();
  if (!c) return json(400, { error: "challenge expired — reload the login page" });
  if (!signature) return json(400, { error: "missing signature" });
  if (!verifyFluxSignature(owner, c.message, signature)) return json(401, { error: "signature does not match the owner wallet" });
  challenges.delete(params.get("challenge") ?? ""); // single-use
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
    headers: { "Set-Cookie": mintSessionCookie(secret, owner, cfg.sessionTtlMs) },
  };
}

/** POST /console/login-callback?challenge=… — Zelcore posts the sig; mark the challenge authed. */
export function handleLoginCallback(cfg: CoalitionConfig, query: URLSearchParams, rawBody: Buffer, contentType: string): ConsoleResult {
  const owner = ownerZelid(cfg);
  if (!owner) return json(500, { status: "error", error: "owner not configured" });
  const c = getChallenge(query.get("challenge") ?? "");
  if (!c) return json(400, { status: "error", error: "challenge expired" });
  const signature = readSignatureFromBody(rawBody, contentType);
  if (!signature) return json(400, { status: "error", error: "missing signature" });
  if (!verifyFluxSignature(owner, c.message, signature)) return json(401, { status: "error", error: "bad signature" });
  c.authedAddr = owner; // the browser's login-status poll will mint the cookie
  return json(200, { status: "success" });
}

/** GET /console/login-status?challenge=… — browser poll; mints the cookie once authed (Zelcore path). */
export function handleLoginStatus(cfg: CoalitionConfig, query: URLSearchParams): ConsoleResult {
  const secret = cfg.sessionSecret;
  const id = query.get("challenge") ?? "";
  const c = getChallenge(id);
  if (!c) return json(200, { status: "expired" });
  if (c.authedAddr && secret) {
    challenges.delete(id); // single-use
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "authenticated" }),
      headers: { "Set-Cookie": mintSessionCookie(secret, c.authedAddr, cfg.sessionTtlMs) },
    };
  }
  return json(200, { status: "pending" });
}
