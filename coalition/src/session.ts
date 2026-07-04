/**
 * Console session cookie (CV6 wallet-login read-gate). The cookie is a low-value
 * HMAC token that proves the browser completed a wallet login — it gates VIEWING
 * the console, nothing more. Every privileged ACTION is still individually
 * wallet-signed (the OwnerAuth blob), so a stolen cookie can read operational
 * state but CANNOT authorize a node action. The coalition stays keyless-for-actions;
 * the only secret here is the cookie-signing `SESSION_SECRET`.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const SESSION_COOKIE = "mt_console";

/** Fresh single-use challenge nonce (hex). */
export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Mint a `Set-Cookie` value binding `addr` for `ttlMs`, HMAC-signed with `secret`. */
export function mintSessionCookie(secret: string, addr: string, ttlMs: number): string {
  const payload = Buffer.from(JSON.stringify({ addr, exp: Date.now() + ttlMs }), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(payload).digest("hex");
  const maxAge = Math.floor(ttlMs / 1000);
  // Path=/console so it only rides console requests; Secure requires HTTPS (Flux
  // ingress in prod, Caddy tls internal on the testbed).
  return `${SESSION_COOKIE}=${payload}.${mac}; HttpOnly; Secure; SameSite=Strict; Path=/console; Max-Age=${maxAge}`;
}

/** Verify the session cookie from request headers; returns the bound addr or null. */
export function verifySession(secret: string, headers: IncomingHttpHeaders): { addr: string } | null {
  const raw = readCookie(headers, SESSION_COOKIE);
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { addr, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { addr: string; exp: number };
    if (typeof exp !== "number" || exp <= Date.now() || typeof addr !== "string") return null;
    return { addr };
  } catch {
    return null;
  }
}

function readCookie(headers: IncomingHttpHeaders, name: string): string | null {
  const cookie = headers["cookie"];
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
