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
 * are login-less — we verify each signature recovers to the operator's owner ZelID
 * before queuing it (the per-action gate + anti-spam). The agent re-verifies
 * authoritatively on pickup.
 */
import type { IncomingHttpHeaders } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  PendingAuthPush,
  type PendingAuthItem,
  type SignedAuthorization,
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
import { buildOwnerAuthSignLauncher, escapeHtmlAttribute } from "@moltentech/protocol/sign-launcher";
import type { CoalitionConfig } from "./config";

export type ConsoleResult = { status: number; contentType: string; body: string };
const json = (status: number, obj: unknown): ConsoleResult => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(obj),
});
const html = (status: number, body: string): ConsoleResult => ({ status, contentType: "text/html; charset=utf-8", body });

// ── In-memory courier state (single-use + short-lived; a restart just means re-sign) ──
const pending = new Map<string, PendingAuthItem>(); // slotId -> item awaiting signature
const authorizations: SignedAuthorization[] = []; // signed, awaiting agent pickup

// ── agent⇄coalition auth: verify the agent's manifest-key signature ──
let cachedPubkey: string | null = null;
function manifestPubkey(cfg: CoalitionConfig): string | null {
  if (cachedPubkey) return cachedPubkey;
  try {
    const m = JSON.parse(readFileSync(cfg.manifestPath, "utf8")) as { pubkey?: string };
    cachedPubkey = m.pubkey ?? null;
  } catch {
    cachedPubkey = null;
  }
  return cachedPubkey;
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

/** GET /agent/authorizations — hand the queued signed blobs to the agent and clear them. */
export function handleAgentAuthorizations(cfg: CoalitionConfig, rawBody: Buffer, headers: IncomingHttpHeaders): ConsoleResult {
  if (!verifyAgentRequest(cfg, "GET", "/agent/authorizations", rawBody, headers)) return json(401, { error: "Unauthorized" });
  const items = authorizations.splice(0, authorizations.length);
  return json(200, { items });
}

// ── operator (browser) handlers ──
/** GET /console — the pending-authorizations list. Login-less (see module doc). */
export function handleConsoleIndex(cfg: CoalitionConfig): ConsoleResult {
  const items = [...pending.values()];
  const rows = items.length
    ? items
        .map((it) => {
          const label = escapeHtmlAttribute(`${it.action} ${it.vmName}@${it.nodeName}`);
          const code = it.rentalCode ? escapeHtmlAttribute(it.rentalCode) : "—";
          return `<tr><td>${label}</td><td>${code}</td><td><a class="btn" href="/console/sign?slotId=${encodeURIComponent(it.slotId)}">Review &amp; sign</a></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="3" style="color:#6b7280">No actions awaiting your signature.</td></tr>`;
  const slug = escapeHtmlAttribute(cfg.providerSlug);
  return html(
    200,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta http-equiv="refresh" content="15"/>
<title>MoltenTech Operator Console — ${slug}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#222}
table{border-collapse:collapse;width:100%;max-width:820px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #e5e7eb}
.btn{display:inline-block;padding:8px 14px;background:#1a1a2e;color:#fff;text-decoration:none;border-radius:8px;font-size:14px}
h1{font-size:20px}</style></head><body>
<h1>Operator Console — ${slug}</h1>
<p>Pending privileged actions. Each is authorized by signing it in your Flux wallet.</p>
<table><thead><tr><th>Action</th><th>Rental</th><th></th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`
  );
}

/** GET /console/sign?slotId=… — build the claim + render the WS1 launcher + a submit form. */
export function handleConsoleSign(cfg: CoalitionConfig, query: URLSearchParams): ConsoleResult {
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
  const { html: launcher } = buildOwnerAuthSignLauncher(claim);

  // Inject a submit form before </body>: it carries the exact claim + the signature
  // (auto-filled from the SSP result box, or pasted for Zelcore) back to us.
  const submit = `
    <div class="wallet-section" style="margin:16px 0;padding:16px;border:1px solid #e5e7eb;border-radius:8px">
      <h2>Submit authorization</h2>
      <p>After signing above, submit the signature to queue this authorization.</p>
      <form method="POST" action="/console/authorize">
        <input type="hidden" name="slotId" value="${escapeHtmlAttribute(slotId)}" />
        <input type="hidden" name="claim" value="${escapeHtmlAttribute(claimToken)}" />
        <textarea name="signature" id="submit-sig" placeholder="Signature (auto-filled from SSP, or paste from Zelcore)" style="font-family:monospace;font-size:13px;width:100%;min-height:56px;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box"></textarea>
        <button type="submit" class="btn btn-zelcore" style="margin-top:8px">Submit authorization</button>
      </form>
      <p style="margin-top:8px"><a href="/console">&larr; Back to pending</a></p>
    </div>
    <script>
      // Mirror the SSP-produced signature into the submit box as it appears.
      (function(){ var src=document.getElementById('sig-output'), dst=document.getElementById('submit-sig');
        if(!src||!dst) return;
        new MutationObserver(function(){ if(src.textContent && !dst.value) dst.value=src.textContent.trim(); })
          .observe(src,{childList:true,characterData:true,subtree:true}); })();
    </script>`;
  return html(200, launcher.replace("</body>", `${submit}</body>`));
}

/** POST /console/authorize — verify the owner signature, then queue for the agent. */
export function handleConsoleAuthorize(cfg: CoalitionConfig, form: URLSearchParams): ConsoleResult {
  const owner = ownerZelid(cfg);
  if (!owner) return html(500, "<p>Console owner address not configured (set OWNER_ADDRESS).</p>");

  const slotId = form.get("slotId") ?? "";
  const claimToken = form.get("claim") ?? "";
  const signature = (form.get("signature") ?? "").trim();
  const claim = decodeClaim(claimToken);
  if (!claim || !signature) return html(400, "<p>Missing claim or signature.</p>");

  // The claim must still match a pending item (no arbitrary/forged claims).
  const item = pending.get(slotId);
  if (!item || item.action !== claim.action || item.vmName !== claim.vmName || item.nodeName !== claim.nodeName || item.providerSlug !== claim.providerSlug) {
    return html(409, "<p>Action no longer pending, or claim does not match.</p>");
  }
  // Per-action gate: the signature must recover to the operator's owner ZelID.
  if (!verifyFluxSignature(owner, ownerAuthMessage(claim), signature)) {
    return html(401, "<p>Signature does not match the owner wallet for this operator.</p>");
  }

  const authParsed = OwnerAuth.safeParse({ ...claim, signature });
  if (!authParsed.success) return html(400, "<p>Malformed authorization.</p>");

  authorizations.push({ slotId, ownerAuth: authParsed.data });
  pending.delete(slotId);
  return html(
    200,
    `<!doctype html><html><head><meta charset="utf-8"/><title>Authorized</title></head><body style="font-family:system-ui;margin:24px">
<h1>Authorization queued ✓</h1><p>${escapeHtmlAttribute(`${claim.action} ${claim.vmName}@${claim.nodeName}`)} will be executed by your agent shortly.</p>
<p><a href="/console">&larr; Back to pending</a></p></body></html>`
  );
}
